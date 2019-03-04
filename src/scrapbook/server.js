/********************************************************************
 *
 * Shared class for server related manipulation.
 *
 * @require {Object} scrapbook
 * @public {Class} Server
 *******************************************************************/

((window, document, browser) => {

class Server {
  constructor () {
    this._config = null;
    this._serverRoot = null;
    this._books = null;
  }

  get serverRoot() {
    return this._serverRoot;
  }

  get config() {
    return this._config;
  }

  get books() {
    return this._books;
  }

  /**
   * Wrapped API for a general request to backend server
   */
  async request(params = {}) {
    params.onload = true;
    let xhr;
    try {
      xhr = await scrapbook.xhr(params);
    } catch (ex) {
      throw new Error('Unable to connect to backend server.');
    }
    if (xhr.response && xhr.response.error && xhr.response.error.message) {
      throw new Error(xhr.response.error.message);
    } else if (!(xhr.status >= 200 && xhr.status <= 206)) {
      const statusText = xhr.status + (xhr.statusText ? " " + xhr.statusText : "");
      throw new Error(statusText);
    }
    return xhr;
  }

  /**
   * Load the config of the backend server
   */
  async init(refresh = false) {
    if (!this._config || refresh) {
      if (!scrapbook.hasServer()) {
        return null;
      }

      let configServerRoot = scrapbook.getOption("capture.scrapbookFolder");

      if (!configServerRoot.endsWith('/')) { configServerRoot += '/'; }

      // use the cached config if the configured server root isn't changed
      if (this._config) {
        if (configServerRoot.startsWith(this._serverRoot)) {
          return this._config;
        }
      }

      // load config from server
      {
        const suffix = '&ts=' + Date.now(); // bust the cache
        const xhr = await this.request({
          url: configServerRoot + '?a=config&f=json' + suffix,
          responseType: 'json',
          method: "GET",
        });

        if (!xhr.response || !xhr.response.data) {
          throw new Error('The server does not support WebScrapBook protocol.');
        }

        this._config = xhr.response.data;
      }

      // revise server root URL
      // configServerRoot may be too deep, replace with server configured base path
      {
        const urlObj = new URL(configServerRoot);
        urlObj.search = urlObj.hash = '';
        urlObj.pathname = this._config.server.base + '/';
        this._serverRoot = urlObj.href;
      }

      // load books
      {
        this._books = {};
        for (const bookId in server.config.book) {
          this._books[bookId] = new Book(bookId, this);
        }
      }
    }
  }

  /**
   * Acquire an access token from the backend server
   */
  async acquireToken(url) {
    try {
      const xhr = await this.request({
        url: (url || this._serverRoot) + '?a=token&f=json',
        responseType: 'json',
        method: "GET",
      });
      return xhr.response.data;
    } catch (ex) {
      throw new Error(`Unable to acquire access token: ${ex.message}`);
    }
  }
}

class Book {
  constructor(bookId, server) {
    this.id = bookId;
    this.config = server.config.book[bookId];
    this.server = server;

    if (!this.config) {
      throw new Error(`unknown scrapbook: ${bookId}`);
    }

    this.topUrl = server.serverRoot +
      (this.config.top_dir ? this.config.top_dir + '/' : '');

    this.dataUrl = this.topUrl +
        (this.config.data_dir ? this.config.data_dir + '/' : '');

    this.treeUrl = this.topUrl +
        (this.config.tree_dir ? this.config.tree_dir + '/' : '');

    this.indexUrl = this.topUrl + this.config.index;

    this.treeFiles = null;
    this.toc = null;
    this.meta = null;
  }

  /**
   * @return {Map}
   */
  async loadTreeFiles() {
    const data = (await this.server.request({
      url: this.treeUrl + '?a=list&f=json',
      responseType: 'json',
      method: "GET",
    })).response.data;

    return this.treeFiles = data.reduce((data, item) => {
      data.set(item.name, item);
      return data;
    }, new Map());
  }

  async loadMeta() {
    const objList = [{}];
    const treeFiles = await this.loadTreeFiles();
    const prefix = this.treeUrl;
    const suffix = '?ts=' + Date.now(); // bust the cache
    for (let i = 0; ; i++) {
      const file = `meta${i || ""}.js`;
      if (treeFiles.has(file) && treeFiles.get(file).type === 'file') {
        const url = prefix + encodeURIComponent(file);
        try {
          const text = (await this.server.request({
            url: url + suffix,
            responseType: 'text',
            method: "GET",
          })).response;

          if (!/^(?:\/\*.*\*\/|[^(])+\(([\s\S]*)\)(?:\/\*.*\*\/|[\s;])*$/.test(text)) {
            throw new Error(`Unable to retrieve JSON data.`);
          }

          objList.push(JSON.parse(RegExp.$1));
        } catch (ex) {
          throw new Error(`Error loading '${url}': ${ex.message}`);
        }
      } else {
        break;
      }
    }
    return this.meta = Object.assign.apply(this, objList);
  }

  async loadToc() {
    const objList = [{}];
    const treeFiles = await this.loadTreeFiles();
    const prefix = this.treeUrl;
    const suffix = '?ts=' + Date.now(); // bust the cache
    for (let i = 0; ; i++) {
      const file = `toc${i || ""}.js`;
      if (treeFiles.has(file) && treeFiles.get(file).type === 'file') {
        const url = prefix + encodeURIComponent(file);
        try {
          const text = (await this.server.request({
            url: url + suffix,
            responseType: 'text',
            method: "GET",
          })).response;

          if (!/^(?:\/\*.*\*\/|[^(])+\(([\s\S]*)\)(?:\/\*.*\*\/|[\s;])*$/.test(text)) {
            throw new Error(`Unable to retrieve JSON data.`);
          }

          objList.push(JSON.parse(RegExp.$1));
        } catch (ex) {
          throw new Error(`Error loading '${url}': ${ex.message}`);
        }
      } else {
        break;
      }
    }
    return this.toc = Object.assign.apply(this, objList);
  }

  async saveToc(theToc) {
    const exportFile = async (toc, i) => {
      const content = this.generateTocFile(toc);
      const file = new File([content], `toc${i || ""}.js`, {type: "application/javascript"});
      const target = this.treeUrl + file.name;

      const formData = new FormData();
      formData.append('token', await this.server.acquireToken());
      formData.append('upload', file);

      await this.server.request({
        url: target + '?a=upload&f=json',
        responseType: 'json',
        method: "POST",
        formData: formData,
      });
    };

    // A javascript string >= 256 MiB (UTF-16 chars) causes an error
    // in the browser. Split each js file at around 4 M entries to
    // prevent the issue. (An entry is mostly < 32 bytes)
    const sizeThreshold = 4 * 1024 * 1024;
    const files = [];

    let i = 0;
    let size = 0;
    let toc = {};
    for (const id in this.toc) {
      toc[id] = this.toc[id];
      size += 1 + toc[id].length;

      if (size >= sizeThreshold) {
        await exportFile(toc, i);
        i += 1;
        size = 0;
        toc = {};
      }
    }
    if (Object.keys(toc).length) {
      await exportFile(toc, i);
      i += 1;
    }

    // remove stale toc files
    const treeFiles = await this.loadTreeFiles();
    for (; ; i++) {
      const path = `toc${i}.js`;
      if (!treeFiles.has(path)) { break; }

      const target = this.treeUrl + path;

      const formData = new FormData();
      formData.append('token', await this.server.acquireToken());

      const xhr = await this.server.request({
        url: target + '?a=delete&f=json',
        responseType: 'json',
        method: "POST",
        formData: formData,
      });
    }
  }

  generateMetaFile(jsonData) {
    return `/**
 * Feel free to edit this file, but keep data code valid JSON format.
 */
scrapbook.meta(${JSON.stringify(jsonData, null, 2)})`;
  }

  generateTocFile(jsonData) {
    return `/**
 * Feel free to edit this file, but keep data code valid JSON format.
 */
scrapbook.toc(${JSON.stringify(jsonData, null, 2)})`;
  }
}

window.Server = Server;
window.server = new Server();

})(this, this.document, this.browser);
