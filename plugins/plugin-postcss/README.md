# @snowpack/plugin-postcss

Runs [PostCSS](https://github.com/postcss/postcss) on all `.css` files, including ones generated from Sass, Vue, and Svelte.

### Usage

Install @snowpack/plugin-postcss, PostCSS, and your PostCSS plugins (not shown):

```
npm i -D @snowpack/plugin-postcss postcss
```

Then add this plugin to your Snowpack config:

```js
// snowpack.config.mjs
export default {
  plugins: ['@snowpack/plugin-postcss'],
};
```

Lastly, add a `postcss.config.js` file. By default, @snowpack/plugin-postcss looks for this in the root directory of your project, but you can customize this with the `config` option.

```js
module.exports = {
  plugins: [
    // Replace below with your plugins
    require('cssnano'),
    require('postcss-preset-env')
  ],
};
```

### Plugin Options

| Name     |        Type        | Description                                                                       |
| :------- | :----------------: | :-------------------------------------------------------------------------------- |
| `input`  |     `string[]`     | File extensions to transform (default: `['.css']`)                                |
| `config` | `string \| object` | (optional) Pass in a PostCSS config object or path to your PostCSS config on disk |
