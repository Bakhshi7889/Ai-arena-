/*!
 * Posterly embed widget — drop this on any website.
 *
 *   <script src="https://poster.example.com/embed/poster.js"></script>
 *   <script>
 *     Posterly.init({ apiKey: 'pst_live_…' });
 *     Posterly.mount('#publisher');            // optional ready-made UI
 *     const job = await Posterly.post({ video: file, title: 'Hi' });
 *   </script>
 *
 * The widget talks to Posterly's public ingest API with CORS, so it works from
 * any origin that is listed in ALLOWED_ORIGINS on the server.
 */
(function (global) {
  'use strict';

  var VERSION = '0.1.0';
  var config = { apiKey: null, endpoint: defaultEndpoint(), defaults: {} };

  function defaultEndpoint() {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i -= 1) {
        var src = scripts[i].src || '';
        if (src.indexOf('/embed/poster.js') !== -1) return src.replace(/\/embed\/poster\.js.*$/, '');
      }
    } catch (e) {
      /* server-side rendering */
    }
    return typeof location !== 'undefined' ? location.origin : '';
  }

  function init(options) {
    options = options || {};
    if (options.apiKey) config.apiKey = options.apiKey;
    if (options.endpoint) config.endpoint = String(options.endpoint).replace(/\/$/, '');
    if (options.defaults) config.defaults = Object.assign({}, config.defaults, options.defaults);
    return Posterly;
  }

  function apiUrl(path) {
    if (!config.endpoint) throw new Error('Posterly: no endpoint. Call Posterly.init({ endpoint }) first.');
    return config.endpoint + path;
  }

  function headers(extra) {
    var h = Object.assign({}, extra);
    if (config.apiKey) h['X-API-Key'] = config.apiKey;
    return h;
  }

  /**
   * Publish a video.
   * @param {Object} input
   * @param {File|Blob} [input.video]  file to upload
   * @param {string} [input.videoUrl] remote URL Posterly should download
   * @param {string} input.title
   * @param {string[]} [input.targets] e.g. ['youtube','tiktok','instagram']
   * @param {function} [input.onProgress] called with 0..1
   */
  function post(input) {
    input = Object.assign({}, config.defaults, input);
    if (!input.title) return Promise.reject(new Error('Posterly.post: "title" is required'));
    if (!input.video && !input.videoUrl) return Promise.reject(new Error('Posterly.post: pass "video" (File) or "videoUrl"'));

    var targets = JSON.stringify(input.targets || config.defaults.targets || ['youtube']);
    var body;
    var contentType;

    if (input.video) {
      body = new FormData();
      body.append('video', input.video, input.video.name || 'video.mp4');
      body.append('title', input.title);
      body.append('targets', targets);
      if (input.description) body.append('description', input.description);
      if (input.tags) body.append('tags', Array.isArray(input.tags) ? input.tags.join(',') : input.tags);
      if (input.visibility) body.append('visibility', input.visibility);
      if (input.callbackUrl) body.append('callbackUrl', input.callbackUrl);
      if (input.scheduledAt) body.append('scheduledAt', input.scheduledAt);
    } else {
      body = JSON.stringify({
        title: input.title,
        videoUrl: input.videoUrl,
        targets: input.targets || config.defaults.targets || ['youtube'],
        description: input.description,
        tags: input.tags || [],
        visibility: input.visibility,
        callbackUrl: input.callbackUrl,
        scheduledAt: input.scheduledAt,
      });
      contentType = { 'Content-Type': 'application/json' };
    }

    var request = input.video ? xhrPost(apiUrl('/api/v1/posts'), body, input.onProgress) : jsonPost(apiUrl('/api/v1/posts'), body, contentType);
    return request.then(function (json) {
      return json.job || json;
    });
  }

  function jsonPost(url, body, extraHeaders) {
    return fetch(url, { method: 'POST', headers: headers(extraHeaders), body: body }).then(handleResponse);
  }

  /** XHR so we can report upload progress for large videos. */
  function xhrPost(url, formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      var h = headers({});
      Object.keys(h).forEach(function (key) {
        xhr.setRequestHeader(key, h[key]);
      });
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = function (event) {
          if (event.lengthComputable) onProgress(event.loaded / event.total);
        };
      }
      xhr.onload = function () {
        var json = safeParse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(json);
        else reject(new Error((json && json.error && json.error.message) || 'Upload failed (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () {
        reject(new Error('Network error while uploading to ' + url));
      };
      xhr.send(formData);
    });
  }

  function handleResponse(res) {
    return res.json().then(function (json) {
      if (!res.ok) throw new Error((json && json.error && json.error.message) || 'Request failed (HTTP ' + res.status + ')');
      return json;
    });
  }

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return {};
    }
  }

  function status(jobId) {
    return fetch(apiUrl('/api/v1/posts/' + encodeURIComponent(jobId)), { headers: headers({}) }).then(handleResponse);
  }

  function platforms() {
    return fetch(apiUrl('/api/v1/platforms'), { headers: headers({}) }).then(handleResponse);
  }

  /** Ready-made drag & drop publisher. `selector` is a CSS selector or element. */
  function mount(selector, options) {
    var host = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!host) throw new Error('Posterly.mount: no element for "' + selector + '"');
    options = options || {};
    var targets = options.targets || config.defaults.targets || ['youtube', 'tiktok', 'instagram'];
    var file = null;

    host.innerHTML =
      '<div class="posterly" style="font-family:system-ui,sans-serif;border:2px dashed #93a0c2;border-radius:14px;padding:18px;text-align:center;color:#e8ecf7;background:#131a2e">' +
      '<div class="posterly-drop" style="cursor:pointer"><strong>' + (options.label || 'Drop a video, or click to choose') + '</strong>' +
      '<div style="opacity:.65;font-size:12px;margin-top:6px">Publishes to ' + targets.join(', ') + '</div></div>' +
      '<input type="file" accept="video/*" style="display:none" />' +
      '<input type="text" placeholder="Title" style="width:100%;margin-top:12px;padding:8px;border-radius:8px;border:1px solid #26314f;background:#101730;color:#e8ecf7" />' +
      '<div class="posterly-bar" style="height:6px;border-radius:6px;background:#26314f;margin-top:12px;overflow:hidden;display:none"><i style="display:block;height:100%;width:0;background:#6c8cff"></i></div>' +
      '<button style="margin-top:12px;width:100%;padding:9px;border:0;border-radius:8px;background:#6c8cff;color:#061029;font-weight:600;cursor:pointer">Publish everywhere</button>' +
      '<div class="posterly-msg" style="font-size:12px;margin-top:10px;opacity:.8"></div>' +
      '</div>';

    var drop = host.querySelector('.posterly-drop');
    var input = host.querySelector('input[type=file]');
    var title = host.querySelector('input[type=text]');
    var button = host.querySelector('button');
    var bar = host.querySelector('.posterly-bar');
    var barFill = bar.querySelector('i');
    var msg = host.querySelector('.posterly-msg');

    drop.addEventListener('click', function () {
      input.click();
    });
    input.addEventListener('change', function () {
      file = input.files[0] || null;
      if (file) msg.textContent = file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)';
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault();
        drop.style.borderColor = '#6c8cff';
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault();
        drop.style.borderColor = '#93a0c2';
      });
    });
    drop.addEventListener('drop', function (e) {
      var dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (dropped) {
        file = dropped;
        msg.textContent = dropped.name + ' (' + (dropped.size / 1048576).toFixed(1) + ' MB)';
      }
    });

    button.addEventListener('click', function () {
      if (!file) {
        msg.textContent = 'Choose a video first.';
        return;
      }
      button.disabled = true;
      bar.style.display = 'block';
      msg.textContent = 'Uploading…';
      post({
        video: file,
        title: title.value || file.name.replace(/\.[^.]+$/, ''),
        targets: targets,
        description: options.description,
        visibility: options.visibility,
        callbackUrl: options.callbackUrl,
        onProgress: function (ratio) {
          barFill.style.width = Math.round(ratio * 100) + '%';
          msg.textContent = 'Uploading… ' + Math.round(ratio * 100) + '%';
        },
      })
        .then(function (job) {
          msg.textContent = 'Queued as ' + job.id + ' — publishing to ' + job.targets.length + ' networks.';
          barFill.style.width = '100%';
          if (typeof options.onPublished === 'function') options.onPublished(job);
        })
        .catch(function (err) {
          msg.textContent = err.message;
          bar.style.display = 'none';
        })
        .then(function () {
          button.disabled = false;
        });
    });

    return { el: host, post: post };
  }

  var Posterly = {
    version: VERSION,
    init: init,
    post: post,
    mount: mount,
    status: status,
    platforms: platforms,
  };

  global.Posterly = Posterly;
  if (typeof module !== 'undefined' && module.exports) module.exports = Posterly;
})(typeof window !== 'undefined' ? window : globalThis);
