var lookup = require('fis3-hook-commonjs/lookup.js');
var commonJs = require('fis3-hook-commonjs/parser.js');
var amd = require('./amd.js');

// 程序入口
var entry = module.exports = function(fis, opts) {
  lookup.init(fis, opts);

  // normalize shim
  // 规整 shim 配置。
  opts.shim && (function() {
    var shim = opts.shim;
    var normalized = {};

    Object.keys(shim).forEach(function(key) {
      var val = shim[key];

      if (Array.isArray(val)) {
        val = {
          deps: val
        }
      }

      var info = lookup(fis.util.query(key));
      if (!info.file) {
        return;
      }

      normalized[info.file.subpath] = val;
    });

    opts.shim = normalized;
  })();

  fis.on('lookup:file', lookup);
  fis.on('standard:js', function(info) {
    var file = info.file;
    var shimed = opts.shim && opts.shim[file.subpath];

    if (file.isMod && file.isJsLike || shimed) {
      // 用户主动配置了 shim 那么说明目标文件一定是模块化 js
      shimed && (file.isMod = true);
      try {
        amd(info, opts);
      } catch (e) {
        fis.log.warn('Got Error: %s while parse [%s].', e.message, file.subpath);
        fis.log.debug(e.stack);
      }
    } else {
      
      // 先尝试 amd 解析，失败则走 commonJs
      // 非模块化的js 一般都只有 require 的用法。
      try {
        amd(info, opts);
      } catch (e) {
        commonJs(info, opts);
      }
    }
  });

  // 支持 data-main 的用法。
  var rScript = /<!--([\s\S]*?)(?:-->|$)|(<script[^>]*>[\s\S]*?<\/script>)/ig;
  var rDataMain = /\bdata-main=('|")(.*?)\1/;
  var lang = fis.compile.lang;

  // 解析 data-main
  fis.on('standard:html', function(info) {
    info.content = info.content.replace(rScript, function(all, comment, script) {
      if (!comment && script) {
        all = all.replace(rDataMain, function(_, quote, value) {
          return lang.info.wrap(lang.jsRequire.wrap(quote + value + quote));
        });
      }

      return all;
    });
  });
};

entry.defaultOptions = {

  // 是否将全局下面的异步用法，当同步处理。
  // 影响的结果是，依赖会提前在页面里面引入进来，而不是运行时去加载。
  globalAsyncAsSync: false,

  // 给那种自己实现 loader 的用户使用的。
  forwardDeclaration: true,

  // 当前置依赖启动的时候才有效，用来控制是否把内建的 `require`, `exports`, `module` 从第二个参数中去掉。
  skipBuiltinModules: false,

  // 用来查找无后缀资源的
  extList: ['.js', '.coffee', '.jsx', '.es6'],

  // 设置包裹时，内容缩进的空格数。
  tab: 2
};
