var esprima = require('esprima');
var estraverse = require('estraverse');
var escope = require('escope');
var rDefine = /('.*?'|".*?"|[^\\]\/\/[^\r\n\f]*|\/\*[\s\S]*?\*\/)|((?:^|[^\.])\bdefine\s*\()/ig;
var rModule = /('.*?'|".*?"|[^\\]\/\/[^\r\n\f]*|\/\*[\s\S]*?\*\/)|((?:^|[^\.])\bmodule\.exports\b|(?:^|[^\.])\bexports\.|(?:^|[^\.])\bexports\[)/ig;
var lang = fis.compile.lang;
var path = require('path');
var _ = fis.util;

var amd = module.exports = function(info, conf) {
  var file = info.file;

  autowrap(info, conf);
  info.content = parse(file, info.content, conf);
  info.content = amd.restoreFISLang(info.content);
};

// 判断是否是 amd
/*amd.test = function(info) {
  var file = info.file;
  var content = info.content;
  var isAMD = false;

  if ('undefined' !== typeof file.module && file.module !== 'amd' || !amd.hasDefine(content)) {
    return false;
  }

  try {
    var ret = analyze(content);

    // cache it.
    file._amdAnalyzed = ret;

    if (ret.modules) {
      var stictModules = ret.modules.filter(function(item) {
        return !item.isLocal;
      });

      if (stictModules.length) {
        isAMD = true;
      } else if (ret.modules.length === 1) {
        // 允许一个内部 define 的定义。
        // 第三方库 `when` 里面的代码 define 都是局部定义的。鬼知道是不是 amd 规范。
        isAMD = true;
      }
    }
  } catch (e) {
    fis.log.warning('Got Error: ' + e.message + ' while parse [' + file.subpath + ']');
  }

  return !!isAMD;
};*/

amd.hasDefine = function(content) {
  var matched = false;

  rDefine.lastIndex = 0; // reset RegExp
  while(!matched && rDefine.test(content)) {
    matched = !!RegExp.$2;
  }

  return matched;
};

/*amd.hasExports = function(content) {
  var matched = false;

  rModule.lastIndex = 0; // reset RegExp
  while(!matched && rModule.test(content)) {
    matched = !!RegExp.$2;
  }

  return matched;
};*/

var backups = null;
amd.backUpFISLang = function(content) {
  var reg = fis.compile.lang.reg;
  var index = 0;

  backups = {};
  content = content.replace(reg, function(all) {
    var key = '__fis_backup' + index++;
    backups[key] = all;
    return key;
  });

  return content;
};

amd.restoreFISLang = function(content) {
  if (backups && !_.isEmpty(backups)) {
    _.forEach(backups, function(value, key) {
      content = content.replace(key, value);
    });
    backups = null;
  }

  return content;
};

function autowrap(info, conf) {
  var shims = conf.shim || {};
  var file = info.file;
  var content = info.content;
  var shim = shims[file.subpath];

  if (!file.isMod || !file.isJsLike || file.isPartial || amd.hasDefine(content)) {
    return;
  }

  var prefix = 'define(function(require, exports, module) {\n\n';
  var affix = '\n\n});';
  var tab = fis.util.pad(' ', conf.tab || 2);

  if (shim && shim.deps) {
    shim.deps.forEach(function(dep) {
      prefix += tab + 'require(\'' + dep + '\');\n';
    });
  }

  if (shim && shim.init) {
    var init = shim.init;

    if (typeof init === 'function') {
      init = Object.toString.call(shim.init);
    }

    affix = tab + 'module.exports = (' + shim.init + ')(' + (function() {
      var deps = [];

      if (shim.deps) {
        shim.deps.forEach(function(dep) {
          deps.push('require(\'' + dep + '\')');
        });
      }

      return deps.join(', ');
    })() + ');\n' + (function() {
      var str = '';

      if (shim.exports) {
        str  = 'module.exports = typeof module.exports === \'undefined\' ? ' + shim.exports + ' : module.exports;\n';
      }

      return str;
    })() + affix;
  } else if (shim && shim.exports) {
    affix = '\n' + tab + 'module.exports = ' + shim.exports + ';\n' + affix;
  }

  if (tab) {
    content = tab + content.split(/\r\n|\n|\r/).join('\n' + tab);
  }

  info.content = prefix + content + affix;
  file.wrap = false;
  fis._amdAnalyzed = null; // 因为改了，所以得让原来的 cache 失效。
}

function parse(file, content, conf) {
  var ret = file._amdAnalyzed || analyze(content);
  var forgetDefine = file.isMod === false || file.isPartial;

  delete file._amdAnalyzed;

  if (!forgetDefine) {
    // 检查 modules 个数
    var modulesCount = 0;
    var stictModulesCount = 0;
    travelRet(ret, function(node) {
      var module = node.module;

      if (module) {
        modulesCount++;
        stictModulesCount += module.isLocal ? 0 : 1;
      }
    });

    if (!stictModulesCount && modulesCount > 1) {
      fis.log.warning('Multi local defines detected in %s, all replacement will be skiped', file.subpath);
      forgetDefine = true;
    }
  }

  var inserts = [];
  var converter = getConverter(content);
  var asyncRequires = [];
  var globalSyncRequires = [];
  var forwardDeclaration = conf.forwardDeclaration;

  var count = 0;
  travelRet(ret, function(node) {
    var module = node.module;

    // 处理模块定义中的替换。
    if (!forgetDefine && module) {

      // 如果存在严格的 define，同时此次处理的是 local define 则直接跳过。
      if (stictModulesCount && module.isLocal) {
        return;
      }

      if (module.id) {
        fis.log.warning('Onymous module `%s` is not allowed here in `%s`, but it will be erased anyway.', module.id, file.subpath);
      }

      var argsRaw = []; // factory 处理前的形参列表。
      var deps = []; // 最终依赖列表
      var args = []; // 最终 factory 的形参列表

      // 获取处理前的原始形参
      var params = module.factory.params;
      params && params.forEach(function(param) {
        argsRaw.push(param.name);
      });

      // deps 是指 define 的第二个参数中指定的依赖列表。
      if (module.deps && module.deps.length) {

        // 添加依赖。
        module.deps.forEach(function(elem) {

          // 不需要查找依赖，如果是 require、module、或者 exports.
          if (~'require,module,exports'.indexOf(elem.value)) {
            deps.push(elem.raw);
            args.push(argsRaw.shift());
            return;
          }

          var v = elem.raw;
          var info = fis.util.stringQuote(v);
          v = info.rest.trim();
          var parts = v.split('!');
          var moduleId = parts.shift();
          var plugins = '';

          if (parts.length) {
            plugins = '!' + parts.map(function(pluginPath) {
              return lang.uri.ld + pluginPath + lang.uri.rd;
            }).join('!');
          }

          deps.push(info.quote + lang.jsRequire.wrap(moduleId) + plugins + info.quote);
          argname = argsRaw.shift();
          argname && args.push(argname);
        });
      }
      //  没有指定的话，原来 factory 里面参数放回去。
      else {
        args = argsRaw.concat();
      }

      if (node.requires && node.requires.length) {
        node.requires.forEach(function(item) {
          if (item.isLocal && item.isLocal.defs[0].name !== module.factory.params[0]) {
            return;
          }

          var elem = item.node.arguments[0];
          var v = elem.value;
          var info = fis.util.stringQuote(elem.raw);
          v = info.rest.trim();
          var parts = v.split('!');
          var moduleId = parts.shift();
          var plugins = '';

          if (parts.length) {
            plugins = '!' + parts.map(function(pluginPath) {
              return lang.uri.ld + pluginPath + lang.uri.rd;
            }).join('!');
          }

          var start = converter(elem.loc.start.line, elem.loc.start.column);
          var transformed = info.quote + lang.jsRequire.wrap(moduleId) + plugins + info.quote;

          inserts.push({
            start: start,
            len: elem.raw.length,
            content: transformed
          });

          // 依赖前置
          if (forwardDeclaration) {
            deps.push(info.quote + lang.moduleId.wrap(moduleId) + plugins + info.quote);
          }
        });
      }

      if (forwardDeclaration && params && !conf.skipBuiltinModules) {
        if (!args.length) {
          args.push('require');
        }

        if (args[0] === 'require' && deps[0] !== '\'require\'' && deps[0] !== '\"require\"') {
          deps.unshift('\'require\'');
        }

        if (args[1] === 'exports' && deps[1] !== '\'exports\'' && deps[1] !== '\"exports\"') {
          deps.splice(1, 0, '\'exports\'');
        }

        if (args[2] === 'module' && deps[2] !== '\'module\'' && deps[2] !== '\"module\"') {
          deps.splice(2, 0, '\'module\'');
        }
      }

      var start, end;

      // 替换 factory args.
      if (args.length && params) {
        if (params.length) {
          start = converter(params[0].loc.start.line, params[0].loc.start.column);
          end = converter(params[params.length - 1].loc.end.line, params[params.length - 1].loc.end.column);
        } else {
          start = converter(module.factory.loc.start.line, module.factory.loc.start.column);
          end = converter(module.factory.loc.end.line, module.factory.loc.end.column);
          start += /^function[^\(]*\(/i.exec(content.substring(start, end))[0].length;
          end = start;
        }

        inserts.push({
          start: start,
          len: end - start,
          content: args.join(', ')
        });
      }

      // 替换 deps
      if (forwardDeclaration || deps.length) {
        start = converter(module.depsLoc.start.line, module.depsLoc.start.column);
        end = converter(module.depsLoc.end.line, module.depsLoc.end.column);

        deps = deps.filter(function(elem, pos, thearr) {
          return args[pos] || thearr.indexOf(elem) === pos;
        });

        inserts.push({
          start: start,
          len: end - start,
          content: '[' + deps.join(', ') + ']' + (module.deps ? '' : ', ')
        });
      }

      var originId = module.id;
      var moduleId = file.moduleId || file.id;
      file.extras.moduleId = moduleId;

      if (count) {
        fis.log.warning('Module replacement skiped in %s, multi defines detected!', file.subpath);
      } else {
        count++;

        if (module.idLoc) {
          start = module.idLoc.start;
          inserts.push({
            start: converter(start.line, start.column),
            len: originId.length + 2,
            content: '\'' + moduleId + '\'',
            weight: -5
          });
        } else {
          start = module.node.loc.start;
          start = converter(start.line, start.column);
          start += /^define\s*\(/.exec(content.substring(start))[0].length;

          inserts.push({
            start: start,
            len: 0,
            content: '\'' + moduleId + '\', ',
            weight: -5
          });
        }
      }

      // 收集异步 require
      if (node.asyncRequires && node.asyncRequires.length) {
        node.asyncRequires.forEach(function(req) {
          req.markAsync = true;
          req.markSync = false;
          asyncRequires.push(req);
        });
      }
      
    } else {
      if (node.asyncRequires && node.asyncRequires.length) {
        [].push.apply(asyncRequires, node.asyncRequires);
      }

      if (node.requires && node.requires) {
        node.requires.forEach(function(req) {
          if (!req.isLocal) {
            globalSyncRequires.push(req);
          }
        });
      }
    }
  });

  asyncRequires.forEach(function(req) {
    // 只有在模块中的异步才被认为是异步？
    // 因为在 define 外面，没有这样的用法： var lib = require('string');
    // 所以不存在同步用法，也就无法把同步依赖提前加载进来。
    // 为了实现提前加载依赖来提高性能，我们把global下的异步依赖认为是同步的。
    //
    // 当然这里有个总开关，可以通过设置 `globalAsyncAsSync` 为 false 来关闭此功能。
    // 另外可以在 require 异步用法的语句前面加上 require async 的注释来，标记异步。
    var async = conf.globalAsyncAsSync ? req.markAsync : !req.markSync;

    (req.deps || []).forEach(function(elem) {
      var v = elem.raw;
      var info = fis.util.stringQuote(v);
      v = info.rest.trim();
      var parts = v.split('!');
      var moduleId = parts.shift();

      var start = elem.loc.start;
      start = converter(start.line, start.column);

      var plugins = '';

      if (parts.length) {
        plugins = '!' + parts.map(function(pluginPath) {
          return lang.uri.ld + pluginPath + lang.uri.rd;
        }).join('!');
      }

      inserts.push({
        start: start,
        len: elem.raw.length,
        content: info.quote + lang[async ? 'jsAsync' : 'jsRequire'].ld + moduleId + lang[async ? 'jsAsync' : 'jsRequire'].rd + plugins + info.quote
      });
    });
  });

  // 兼容老用法。
  globalSyncRequires.forEach(function(item) {
    var elem = item.node.arguments[0];
    var v = elem.raw;
    var info = fis.util.stringQuote(v);
    v = info.rest.trim();
    var start = converter(elem.loc.start.line, elem.loc.start.column);

    inserts.push({
      start: start,
      len: elem.raw.length,
      content: info.quote + lang.jsRequire.ld + v + lang.jsRequire.rd + info.quote
    });
  });

  content = bulkReplace(content, inserts);
  return content;
}

function analyze(content) {
  // 备份中间码。
  content = amd.backUpFISLang(content);

  var ast = esprima.parse(content, {
    loc: true,
    attachComment: true,
    range: true,
    tokens: true
  });

  var scopes = escope.analyze(ast).scopes;
  var gs = scopes.filter(function(scope) {
    return scope.type == 'global';
  })[0];

  var global = {};
  var stack = [global];

  traverse(ast, scopes, gs, function(type, info) {
    var parent = stack[stack.length - 1];

    if (type === 'define') {
      var container = {
        module: info
      };

      parent.modules = parent.modules || [];
      parent.modules.push(container);
      stack.push(container);
    } else if (type === 'require') {
      parent.requires = parent.requires || [];
      parent.requires.push(info);
    } else if (type === 'asyncRequire') {
      parent.asyncRequires = parent.asyncRequires || [];
      parent.asyncRequires.push(info);
    }

  }, function(type, info) {
    if (type === 'define') {
      stack.pop();
    }
  });

  return global;
};

function traverse(ast, scopes, gs, enter, leave) {
  estraverse.traverse(ast, {
    enter: function(current, parent) {

      // 检测 define(id?, deps?, factory);
      if (current.type === 'CallExpression' &&
        current.callee.type === 'Identifier' &&
        current.callee.name === 'define' &&

        (
          current.arguments[current.arguments.length - 1].type === 'ObjectExpression' ||
          current.arguments[current.arguments.length - 1].type === 'FunctionExpression' ||
          current.arguments[current.arguments.length - 1].type === 'FunctionDeclaration' ||
          current.arguments[current.arguments.length - 1].type === 'ArrayExpression' ||
          current.arguments[current.arguments.length - 1].type === 'Identifier' 
        )
      ) {

        // 查找 define 的定义，如果没有定义，说明是全局的。
        // 否则说明是局部 define.
        var ref = findRef(gs, current.callee);

        // 如果是局部 define 则忽略。
        // if (ref.resolved) {
        //   return;
        // }

        var info = {
          isLocal: !!ref.resolved
        };
        var args = current.arguments;

        info.node = current;

        var idx = 0;

        if (args[idx].type == 'Literal') {
          info.id = args[idx].value;
          info.idLoc = args[idx].loc;
          idx++;
        }

        var deps = null;
        if (args[idx].type == 'ArrayExpression') {
          deps = args[idx].elements.filter(function(elm) {

            if (elm.type !== 'Literal') {
              fis.log.warning('WARN: not a standard define method.');
              return false;
            }

            return true;
          });

          info.deps = deps;
          info.depsLoc = args[idx].loc;
        } else {
          var loc = args[idx].loc.start;

          info.depsLoc = {
            start: {
              line: loc.line,
              column: loc.column
            },
            end: {
              line: loc.line,
              column: loc.column
            }
          }
        }

        var factory = current.arguments[current.arguments.length - 1];

        info.factory = factory;
        current.isDefine = true;
        current.info = info;

        enter('define', info);
      } else

      // 检查 require('xxxx')
      if (current.type === 'CallExpression' &&

        current.callee.type === 'Identifier' &&
        current.callee.name === 'require' &&

        current.arguments.length == 1 &&

        current.arguments[0].type === 'Literal') {

        var info = {};
        info.node = current;

        // 查找 require 的定义
        var ref = findRef(gs, current.callee);
        info.isLocal = ref.resolved;

        current.isRequire = true;
        current.info = info;
        enter('require', info);
      } else

      // 检查 require([xxx, xxx?], callback?);
      if (current.type === 'CallExpression' &&

        current.callee.type === 'Identifier' &&
        current.callee.name === 'require' &&

        current.arguments[0].type === 'ArrayExpression') {

        var info = {};
        var args = current.arguments;

        info.node = current;

        var deps = null;
        deps = args[0].elements.filter(function(elm) {

          if (elm.type !== 'Literal') {
            fis.log.warning('WARN: not a standard require method.');
            return false;
          }

          return true;
        });

        info.deps = deps;

        // 判断是否存在手动标记为异步的注释块。
        var leavelist = this.__leavelist;
        var i = leavelist.length;
        var item, node, comments = [],
          _comments;

        while ((item = leavelist[--i])) {
          node = item.node;
          _comments = node && node.leadingComments;

          if (_comments) {
            comments.push.apply(comments, _comments);
          }
        }

        comments.forEach(function(comment) {
          if (/fis\s+async/i.exec(comment.value)) {
            info.markAsync = true;
          } else if (/fis\s+sync/i.exec(comment.value)) {
            info.markSync = true;
          }
        });

        // 查找 require 的定义
        var ref = findRef(gs, current.callee);
        info.isLocal = ref.resolved;

        current.isAsyncRequire = true;
        current.info = info;

        enter('asyncRequire', info);
      } else

      // 老版本使用兼容:
      // require.async(xxx, callback?);
      // require.async([xxxx, xxx?], callback?)
      if (current.type === 'CallExpression' &&

        current.callee.type === 'MemberExpression' &&
        current.callee.object.name === 'require' &&
        current.callee.property.name === 'async' &&

        (
          current.arguments[0].type === 'ArrayExpression' ||
          current.arguments[0].type === 'Literal'
        )
      ) {

        var info = {};
        var args = current.arguments;

        info.node = current;

        var deps = null;

        if (args[0].type === 'ArrayExpression') {
          deps = args[0].elements.filter(function(elm) {

            if (elm.type !== 'Literal') {
              fis.log.warning('WARN: not a standard require method.');
              return false;
            }

            return true;
          });
        } else if (args[0].type === 'Literal') {
          deps = [
            args[0]
          ];
        }

        info.deps = deps;

        current.isAsyncRequire = true;
        current.info = info;

        enter('asyncRequire', info);
      }
    },

    leave: function(current, parent) {
      if (current.isDefine) {
        leave('define', current.info);
      } else if (current.isRequire) {
        leave('require', current.info);
      } else if (current.isAsyncRequire) {
        leave('asyncRequire', current.info);
      }
    }
  });
}

function findRef(scope, ident) {
  var refs = scope.references;
  var i = 0;
  var ref, childScope;

  while ((ref = refs[i++])) {

    if (ref.identifier === ident) {
      return ref;
    }
  }

  i = 0;

  while ((childScope = scope.childScopes[i++])) {

    if ((ref = findRef(childScope, ident))) {
      return ref;
    }
  }
}

function travelRet(info, visitor, child) {
  visitor(info, !child);

  if (info.modules && info.modules) {
    info.modules.forEach(function(node) {
      travelRet(node, visitor, true);
    });
  }
}

// 生成转换坐标为位置的函数。
function getConverter(content) {
  var rbr = /\r\n|\r|\n/g;
  var steps = [0],
    m;

  rbr.lastIndex = 0;
  while ((m = rbr.exec(content))) {
    steps.push(m.index + m[0].length);
  }

  return function(line, column) {
    if (steps.length < line) {
      return -1;
    }

    return steps[line - 1] + column;
  };
};

// like array.splice
function strSplice(str, index, count, add) {
  return str.slice(0, index) + add + str.slice(index + count);
}

function bulkReplace(content, arr) {
  arr
    .sort(function(a, b) {
      var diff = b.start - a.start;

      if (!diff) {
        a.weight = a.weight >> 0;
        b.weight = b.weight >> 0;

        if (a.weight !== b.weight) {
          return b.weight - a.weight;
        }

        return b.len - a.len;
      }

      return diff;
    })
    .forEach(function(item) {
      content = strSplice(content, item.start, item.len, item.content);
    });

  return content;
}
