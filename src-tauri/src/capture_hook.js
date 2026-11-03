// Runs inside every frame of a capture window, on pages we don't control. It can only
// report addresses: that window has no other permission. See capture.rs.
(function () {
  if (window.__stremCapture) return
  Object.defineProperty(window, '__stremCapture', { value: true })

  var MANIFEST_ADDRESS = /\.(m3u8|mpd)(\?|#|$)/i
  var PIECE_ADDRESS = /\.(ts|m4s|m4a|aac)(\?|#|$)/i
  var MEDIA_TYPE = /mpegurl|dash\+xml|^\s*video\/(?!mp2t)/i
  var NOTHING_FOUND_CHECKS = 30
  var CHECK_EVERY = 2000

  var isTop = window === window.top
  var sent = {}

  function send(report) {
    var internals = window.__TAURI_INTERNALS__
    if (internals) internals.invoke('capture_report', { report: report }).catch(function () {})
  }

  function report(url, via, contentType, duration, width) {
    var address
    try {
      address = new URL(url, location.href).href
    } catch (e) {
      return
    }
    if (!/^https?:/i.test(address)) return // blob: and data: only exist inside this page.

    var key = address + '|' + (duration || 0) + '|' + (width || 0)
    if (sent[key]) return
    sent[key] = true

    var found = {
      url: address,
      via: via,
      contentType: contentType || null,
      duration: duration && isFinite(duration) ? duration : null,
      width: width || null,
      frame: location.href,
      userAgent: navigator.userAgent,
    }
    // Only the top frame is sure to have the app's IPC script.
    if (isTop) send(found)
    else window.top.postMessage({ stremCapture: found }, '*')
  }

  function noteResponse(url, via, contentType) {
    var type = contentType || ''
    if (PIECE_ADDRESS.test(url)) return
    if (MANIFEST_ADDRESS.test(url) || MEDIA_TYPE.test(type)) report(url, via, type)
  }

  if (isTop) {
    window.addEventListener('message', function (event) {
      if (event.data && event.data.stremCapture) send(event.data.stremCapture)
    })
  }

  var pageFetch = window.fetch
  if (pageFetch) {
    window.fetch = function (input) {
      var asked = input && input.url ? input.url : input
      return pageFetch.apply(this, arguments).then(function (response) {
        noteResponse(response.url || String(asked), 'fetch', response.headers.get('content-type'))
        return response
      })
    }
  }

  var pageOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    var request = this
    request.addEventListener('readystatechange', function () {
      if (request.readyState === 2) {
        noteResponse(request.responseURL || String(url), 'xhr', request.getResponseHeader('content-type'))
      }
    })
    return pageOpen.apply(this, arguments)
  }

  function checkElements() {
    document.querySelectorAll('video').forEach(function (video) {
      video.muted = true
      if (video.currentSrc) report(video.currentSrc, 'element', null, video.duration, video.videoWidth)
    })
    document.querySelectorAll('video source[src]').forEach(function (source) {
      report(source.src, 'element', source.type)
    })
  }

  // What a person pressing play would start. Players often load nothing before that.
  function pressPlay() {
    document.querySelectorAll('video').forEach(function (video) {
      video.muted = true
      var playing = video.play()
      if (playing && playing.catch) playing.catch(function () {})
    })
    try {
      var player = typeof window.jwplayer === 'function' && window.jwplayer()
      if (player && player.play) {
        if (player.setMute) player.setMute(true)
        player.play()
      }
    } catch (e) {}
    var button = document.querySelector(
      '.vjs-big-play-button, .jw-icon-display, .plyr__control--overlaid, .play-button, #play',
    )
    if (button) button.click()
  }

  var checks = 0
  setInterval(function () {
    checkElements()
    if (checks++ < NOTHING_FOUND_CHECKS) pressPlay()
  }, CHECK_EVERY)
})()
