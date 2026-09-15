// The path module as the extension's page generator uses it: joining extension paths.
module.exports = { join: (...parts) => parts.join('/').replace(/\/+/g, '/') };
