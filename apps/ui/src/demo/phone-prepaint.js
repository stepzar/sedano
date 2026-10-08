// `?phone=1`: the phone's layout and appearance on any browser, so the landing
// page can show the real phone UI inside a phone mockup on a desktop. Inlined
// into the demo's index.html (vite.demo.config.ts) before the app's own
// pre-paint script, because that script and store.ts decide the appearance
// profile from `matchMedia('(pointer: coarse)')` and `screen` at load.
//
// - touch media queries answer as on a phone, in JS (matchMedia) and in CSS
//   (each `(hover: none)` / `(pointer: coarse)` rule is copied with its
//   condition made true);
// - `screen` reports an iPhone 17 Pro (402×874);
// - with `embed=1` the page gets the iPhone's safe areas, because the mockup
//   draws a status bar and a home indicator over the frame's edges.
;(function () {
  try {
    var params = new URLSearchParams(location.search)
    if (params.get('phone') !== '1') return
    var root = document.documentElement
    root.dataset.demoPhone = '1'

    var TOUCH = /\(\s*(any-)?(pointer\s*:\s*coarse|hover\s*:\s*none)\s*\)/g
    var MOUSE = /\(\s*(any-)?(pointer\s*:\s*fine|hover\s*:\s*hover)\s*\)/g
    var asPhone = function (query) {
      return query.replace(TOUCH, '(min-width: 0px)').replace(MOUSE, '(max-width: -1px)')
    }

    var native = window.matchMedia.bind(window)
    window.matchMedia = function (query) {
      return native(asPhone(String(query)))
    }
    Object.defineProperty(screen, 'width', { get: function () { return 402 } })
    Object.defineProperty(screen, 'height', { get: function () { return 874 } })

    if (params.get('embed') === '1') {
      root.style.setProperty('--safe-top', '62px')
      root.style.setProperty('--safe-bottom', '34px')
    }

    var copyTouchRules = function () {
      var out = []
      var walk = function (rules, layer) {
        for (var i = 0; i < rules.length; i++) {
          var rule = rules[i]
          if (rule instanceof CSSMediaRule) {
            var condition = rule.conditionText || rule.media.mediaText
            TOUCH.lastIndex = 0
            if (!TOUCH.test(condition)) continue
            var body = ''
            for (var j = 0; j < rule.cssRules.length; j++) body += rule.cssRules[j].cssText + '\n'
            var block = '@media ' + asPhone(condition) + ' {\n' + body + '}'
            out.push(layer ? '@layer ' + layer + ' {\n' + block + '\n}' : block)
          } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
            walk(rule.cssRules, layer ? layer + '.' + rule.name : rule.name)
          } else if (rule.cssRules) {
            walk(rule.cssRules, layer)
          }
        }
      }
      for (var k = 0; k < document.styleSheets.length; k++) {
        try {
          walk(document.styleSheets[k].cssRules, '')
        } catch (error) {
          /* a sheet from another origin: not ours */
        }
      }
      var style = document.createElement('style')
      style.dataset.demoPhone = 'touch'
      style.textContent = out.join('\n')
      document.head.append(style)
    }
    document.addEventListener('DOMContentLoaded', copyTouchRules, { once: true })
  } catch (error) {
    /* an old browser: the demo still runs, in the layout its width gives it */
  }
})()
