/**
 * @snowpack/plugin-react-refresh (Fast Refresh)
 * Based on details provided by:
 * - https://github.com/facebook/react/issues/16604#issuecomment-528663101
 * - https://github.com/vitejs/vite-plugin-react (see LICENSE)
 */

const fs = require('fs');

const reactRefreshLoc = require.resolve('react-refresh/cjs/react-refresh-runtime.development.js');
const reactRefreshCode = fs
  .readFileSync(reactRefreshLoc, {encoding: 'utf-8'})
  .replace(`process.env.NODE_ENV`, JSON.stringify('development'));

function transformHtml(contents) {
  return contents.replace(/(<body.*?>)/s, function (match, p1) {
    return `${p1}
<script>
  function debounce(e,t){let u;return()=>{clearTimeout(u),u=setTimeout(e,t)}}
  {
    const exports = {};
    ${reactRefreshCode}
    exports.performReactRefresh = debounce(exports.performReactRefresh, 30);
    window.$RefreshRuntime$ = exports;
    window.$RefreshRuntime$.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
  }
</script>`;
  });
}

const babel = require('@babel/core');
const IS_FAST_REFRESH_ENABLED = /\$RefreshReg\$\(/;
async function transformJs(contents, id, cwd, babelConfig) {
  let fastRefreshEnhancedCode;

  if (babelConfig === false) {
    fastRefreshEnhancedCode = contents;
  } else if (IS_FAST_REFRESH_ENABLED.test(contents)) {
    // Warn in case someone has a bad setup, and to help older users upgrade.
    console.warn(
      `[@snowpack/plugin-react-refresh] ${id}\n"react-refresh/babel" plugin no longer needed in your babel config, safe to remove.`,
    );
    fastRefreshEnhancedCode = contents;
  } else {
    const {plugins = [], ...restConfig} = babelConfig instanceof Object ? babelConfig : {};
    const {code} = await babel.transformAsync(contents, {
      cwd,
      filename: id,
      ast: false,
      compact: false,
      sourceMaps: false,
      configFile: false,
      babelrc: false,
      plugins: [
        [require('react-refresh/babel'), {skipEnvCheck: true}],
        require('@babel/plugin-syntax-class-properties'),
        ...plugins,
      ],
      ...restConfig,
    });
    fastRefreshEnhancedCode = code;
  }

  // If fast refresh markup wasn't added, just return the original content.
  if (!fastRefreshEnhancedCode || !IS_FAST_REFRESH_ENABLED.test(fastRefreshEnhancedCode)) {
    return contents;
  }

  return `
/** React Refresh: Setup **/
if (!window.$reactOldComponents$){
  window.$reactOldComponents$ = {}
}
window.$reactFunctionComponentWasChanged$ = false
if (import.meta.hot) {
  if (!window.$RefreshReg$ || !window.$RefreshSig$ || !window.$RefreshRuntime$) {
    console.warn('@snowpack/plugin-react-refresh: HTML setup script not run. React Fast Refresh only works when Snowpack serves your HTML routes. You may want to remove this plugin.');
  } else {
    var prevRefreshReg = window.$RefreshReg$;
    var prevRefreshSig = window.$RefreshSig$;
    window.$RefreshReg$ = (type, id) => {
      const newComponent = type.toString()
      //check if any (function) components tracked by React Refresh have been changed.
      if (window.$reactOldComponents$[id] && window.$reactOldComponents$[id] !== newComponent){
        window.$reactFunctionComponentWasChanged$ = true
      }
      window.$reactOldComponents$[id] = newComponent
      window.$RefreshRuntime$.register(type, ${JSON.stringify(id)} + " " + id);
    }
    window.$RefreshSig$ = window.$RefreshRuntime$.createSignatureFunctionForTransform;
  }
}

${fastRefreshEnhancedCode}

/** React Refresh: Connect **/
if (import.meta.hot) {
  window.$RefreshReg$ = prevRefreshReg
  window.$RefreshSig$ = prevRefreshSig
  import.meta.hot.accept(() => {
    // If a change occured somewhere outside of a function component,
    // that means there is a change that React Refresh cannot deal with, so do a full reload.
    if (window.$reactFunctionComponentWasChanged$) {
      window.$RefreshRuntime$.performReactRefresh()
    } else import.meta.hot.invalidate();
  });
}`;
}

module.exports = function reactRefreshTransform(snowpackConfig, {babel}) {
  return {
    name: '@snowpack/plugin-react-refresh',
    transform({contents, fileExt, id, isDev, isHmrEnabled, isSSR}) {
      // Use long-form "=== false" to handle older Snowpack versions
      if (isHmrEnabled === false) {
        return;
      }
      if (!isDev) {
        return;
      }

      // While server-side rendering, the fast-refresh code is not needed.
      if (fileExt === '.js' && !isSSR) {
        return transformJs(contents, id, snowpackConfig.root || process.cwd(), babel);
      }
      if (fileExt === '.html') {
        return transformHtml(contents);
      }
    },
  };
};
