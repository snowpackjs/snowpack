---
layout: ../../layouts/content.astro
title: 'PostCSS'
tags: communityGuide
published: true
img: '/img/logos/postcss.svg'
imgBackground: '#f8f8f2'
description: How to use PostCSS in your Snowpack project.
---

[PostCSS](https://postcss.org/) is a popular CSS transpiler with support for [a huge ecosystem of plugins.](https://github.com/postcss/postcss#plugins)

**To use PostCSS with Snowpack:** Install [@snowpack/plugin-postcss](https://www.npmjs.com/package/@snowpack/plugin-postcss), [PostCSS](https://www.npmjs.com/package/postcss), and your PostCSS plugins, then add this plugin to your Snowpack config.

```js
// snowpack.config.mjs
export default {
  plugins: ['@snowpack/plugin-postcss'],
};
```

Lastly, add a `postcss.config.js` file. By default, @snowpack/plugin-postcss looks for this in the root directory of your project, but you can customize this with the `config` option. See [the plugin README](https://www.npmjs.com/package/@snowpack/plugin-postcss) for all available options.

```js
// postcss.config.js
module.exports = {
  plugins: [
    // Replace below with your plugins
    require('cssnano'),
    require('postcss-preset-env')
  ],
};
```

Be aware that this plugin will run on all CSS in your project, including any files that compiled to CSS (like `.scss` Sass files).
