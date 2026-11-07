// AMA TV: draws a name onto a birthday poster template (a design with the name area left empty).
// A template's settings say where the name goes and how it looks:
//   box:   { cx, base, maxW }   centre of the name, its baseline and the widest it may be, in pixels on the
//                                poster (or { cx, cy, h, maxW }: centre and lettering height)
//   w, h:  the poster's size in pixels: 1920 x 1080 for the TV (the default), e.g. 1240 x 1754 for the upright tablets
//   size:  the design's letter size in pixels. Long names shrink to fit maxW (staying centred); short ones keep this size.
//   font:  'Luckiest Guy' | 'Knewave' | 'Montserrat' | ...   weight: e.g. 800
//   fill:  '#fed402'   stroke: '#000000' or ''   strokeWidth: outline thickness as a fraction of the letter size
//   curve: arch in degrees (0 = straight)   spacing: extra space between letters, as a fraction of the size
//   uppercase: true/false
(function () {
  'use strict';
  var W = 1920, H = 1080;
  var FONTS = {
    'Luckiest Guy': { css: 'Luckiest+Guy', weight: 400 },
    'Knewave': { css: 'Knewave', weight: 400 },
    'Montserrat': { css: 'Montserrat:wght@800;900', weight: 800 },
    'Bangers': { css: 'Bangers', weight: 400 },
    'Lilita One': { css: 'Lilita+One', weight: 400 },
    'Barlow Semi Condensed': { css: 'Barlow+Semi+Condensed:wght@700', weight: 700 }
  };

  // Make sure a poster font has downloaded before drawing with it
  var sheets = {};
  function loadFont(family, weight) {
    var f = FONTS[family];
    if (f && !sheets[family]) {
      sheets[family] = new Promise(function (ok) {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.setAttribute('data-poster-font', family);
        l.href = 'https://fonts.googleapis.com/css2?family=' + f.css + '&display=block';
        l.onload = l.onerror = function () { ok(); };
        setTimeout(ok, 6000);
        document.head.appendChild(l);
      });
    }
    var spec = (weight || (f && f.weight) || 400) + ' 100px "' + family + '"';
    return Promise.resolve(sheets[family]).then(function () {
      if (!document.fonts || !document.fonts.load) return;
      return document.fonts.load(spec, 'ABCabc').then(function () { return document.fonts.ready; });
    }).catch(function () {});
  }

  function layout(ctx, text, t) {
    var weight = t.weight || (FONTS[t.font] && FONTS[t.font].weight) || 400;
    var face = function (size) { return weight + ' ' + size + 'px "' + t.font + '", "Arial Black", Arial, sans-serif'; };
    ctx.font = face(100);
    var cap = ctx.measureText('H').actualBoundingBoxAscent / 100 || 0.72;
    var sw = t.stroke ? (t.strokeWidth || 0) : 0;
    // The design's letter size; else from the marked box's height; else (a box with only a baseline) a sensible default
    var size = t.size || (t.box.h ? t.box.h / (cap + sw) : Math.round((t.box.maxW || (t.w || W) * 0.7) * 0.24));
    var measure = function (sz) {
      ctx.font = face(sz);
      var chars = Array.from(text), sp = (t.spacing || 0) * sz, adv = [], total = 0;
      if (!sp && !t.curve) {
        var m = ctx.measureText(text);
        return { width: Math.max(m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight) + sw * sz, whole: true, total: m.width };
      }
      for (var i = 0; i < chars.length; i++) { var a = ctx.measureText(chars[i]).width; adv.push(a); total += a + (i ? sp : 0); }
      return { width: total + sw * sz, chars: chars, adv: adv, sp: sp, total: total };
    };
    var m = measure(size), full = size;
    if (m.width > t.box.maxW) { size *= t.box.maxW / m.width; m = measure(size); }
    m.size = size; m.cap = cap * size; m.sw = sw * size; m.face = face(size);
    m.lift = (full - size) * cap / 2;   // a shrunk name stays centred on the design's line
    return m;
  }

  function drawText(ctx, text, t) {
    var m = layout(ctx, text, t), cx = t.box.cx;
    var base = t.box.base != null ? t.box.base - m.lift : t.box.cy + m.cap / 2;
    ctx.font = m.face; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    var passes = [];
    if (t.stroke && m.sw > 0) passes.push(function () { ctx.strokeStyle = t.stroke; ctx.lineWidth = m.sw; return 'stroke'; });
    passes.push(function () { ctx.fillStyle = t.fill || '#ffffff'; return 'fill'; });
    passes.forEach(function (setup) {
      var how = setup();
      var paint = function (s, x, y) { if (how === 'stroke') ctx.strokeText(s, x, y); else ctx.fillText(s, x, y); };
      if (m.whole) { ctx.textAlign = 'center'; paint(text, cx, base); return; }
      ctx.textAlign = 'center';
      if (!t.curve) {
        var x = cx - m.total / 2;
        for (var i = 0; i < m.chars.length; i++) { paint(m.chars[i], x + m.adv[i] / 2, base); x += m.adv[i] + m.sp; }
        return;
      }
      // Arched: letters sit on a circle below the text, so the middle rises
      var sweep = t.curve * Math.PI / 180, R = m.total / sweep, ox = cx, oy = base + R, pos = -m.total / 2;
      for (var j = 0; j < m.chars.length; j++) {
        var mid = pos + m.adv[j] / 2, ang = mid / R;
        ctx.save(); ctx.translate(ox + R * Math.sin(ang), oy - R * Math.cos(ang)); ctx.rotate(ang);
        paint(m.chars[j], 0, 0); ctx.restore();
        pos += m.adv[j] + m.sp;
      }
    });
  }

  // Draw the poster: the template image with the name on it. Returns a promise once fonts are ready.
  function renderPoster(canvas, img, t, name) {
    var w = t.w || W, h = t.h || H;
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    return loadFont(t.font, t.weight).then(function () {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      var text = String(name || '').trim();
      if (t.uppercase) text = text.toUpperCase();
      if (text) drawText(ctx, text, t);
      return canvas;
    });
  }

  window.AMAPoster = { render: renderPoster, loadFont: loadFont, FONTS: FONTS, W: W, H: H };
})();
