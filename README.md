# fis3-hook-amd

fis3 已经默认不自带模块化开发支持，那么如果需要采用 amd 规范作为模块化开发，请使用此插件。

## 安装

全局安装或者本地安装都可以。

```
npm install -g fis3-hook-amd
```

或者

```
npm install fis3-hook-amd
```

## 用法

在 fis-conf.js 中加入以下代码。


```js
fis.hook('amd', {
  // 配置项
});
```

## 重要说明

请配合 require.js 或者 esl.js 或者其他满足 amd 规范的前端加载器一起使用。

注意：需要对目标文件设置 `isMod` 属性，说明这些文件是模块化代码。


```js
fis.match('/modules/**.js', {
  isMod: true
})
``` 

只有标记是模块化的 js 才会去解析。

fis 的 amd 方案，是把对依赖的分析过程从运行期改成了编译期，所以请尽量不要设置 `require.config({options...})`, 因为一旦设置了 `baseUrl` 和 `paths` 或者 `packages` 什么的，会让 `fis` 静态编译时分析变得很困难，甚至分析不到。

但是，你可以给在编译期做同样的配置。

// in fis-conf.js

```
fis.hook('amd'{
  baseUrl: './modules',
  paths: {
    $: 'jquery/jquery-1.11.2.js'
  }
})
```

具体请查看[配置项说明](#配置项)。

## 配置项

* `globalAsyncAsSync` 是否将全局下面的异步用法，当同步处理。作用是，本来要运行时加载的，现在变成页面里面直接引用了。
* `baseUrl` 默认为 `.` 即项目根目录。用来配置模块查找根目录。
* `paths` 用来设置别名，路径基于 `baseUrl` 设置。
  
  ```js
  fis.hook('amd', {
    paths: {
      $: '/modules/jquery/jquery-1.11.2.js'
    }
  });
  ```
* `packages` 用来配置包信息，方便项目中引用。
  
  ```js
  fis.hook('amd', {
    packages: [
      {
        name: 'foo',
        location: './modules/foo',
        main: 'index.js'
      }
    ]
  });
  ```

  * 当 `require('foo')` 的时候等价于 `require('/modules/foo/index.js')`.
  * 当 `require('foo/a.js')` 的时候，等价于 `require('/modules/foo/a.js')`.
* `shim` 可以达到不改目标文件，指定其依赖和暴露内容的效果。**注意只对不满足amd的js有效**
  
  ```js
  fis.hook('amd', {
      shim: {
          'comp/2-0/2-0.js': {
              deps: ['jquery'],
              exports: 'myFunc'
          }
      }
  });
  ```
* `forwardDeclaration` 默认为 `false`, 用来设置是否开启依赖前置，根据前端加载器来定，mod.js 是不需要的。
* `skipBuiltinModules` 默认为 `true`, 只有在 `forwardDeclaration` 启动的时候才有效，用来设置前置依赖列表中是否跳过内置模块如： `require`, `module`, `exports`。
* `extList` 默认为 `['.js', '.coffee', '.jsx', '.es6']`，当引用模块时没有指定后缀，该插件会尝试这些后缀。
* `tab` 默认为 `2`, 用来设置包裹时，内容缩进的空格数。
