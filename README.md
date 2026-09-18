# Casio fx-50FH II — web replica with a guest OS

A working fx-50FH II built on a photo of the real thing. Every key is an
invisible hotspot positioned over the printed button, and the LCD is a real
`<canvas>` sitting exactly on the glass.

```
index.html   the "hardware": LCD, keypad, key event bus, built-in modes
os.js        a guest operating system that borrows the screen
```

Drop both files in a repo and turn on GitHub Pages. No build step, no
dependencies.

---

## The calculator

It starts **off**, like the real thing. Press **ON** to wake it.

Pressing **ON** again at any point resets the machine to a clean state —
input, answer, memory and the modifier latches all cleared. If the OS is
running, **ON** closes it instantly and drops you back to a fresh
calculator.

Two-line display:

```
 12+34          <- top line, what you are entering
            46  <- bottom line, the answer
```

Trig works in **degrees**, so `sin(30)` gives `0.5`.

`MODE` (a short tap) opens a placeholder mode screen. The real machine has
one calculation mode and that's all this shows; `AC` returns.

A physical keyboard works too: digits, `+ - * / ^ ( ) .`, `Enter` = EXE,
`Backspace` = DEL, `Esc` = AC, arrow keys, `m` = MODE, `s` = SHIFT.

---

## The secret: SOS

Tap **SOS in morse on the MODE key** to boot `os.js`:

```
· · ·   — — —   · · ·
```

Short tap = dot. Hold for about 0.4s = dash. The row of pips under the
calculator shows how far along you are. A 2.5 second pause resets it.

The screen switches to **colour** while the OS runs, and the frame picks up
a backlight glow — the monochrome LCD palette belongs to the calculator
firmware only.

Press `AC` on the OS homescreen, or `ON` from anywhere, to drop back into
the calculator.

---

## Writing your own OS

`os.js` gets the LCD and the key stream, and nothing else. It cannot touch
the page, the DOM, or the calculator's own state.

```js
window.CASIO_OS = {
  name: 'MyOS',
  version: '1.0',

  boot(api)   { /* called once when SOS unlocks */ },
  onKey(ev)   { /* every key event */ },
  render(ctx, w, h) { /* draw one frame, 696 x 260 */ },
  shutdown()  { /* clear your timers */ }
};
```

### The `api` object

| call | gives you |
|---|---|
| `api.screen` | `{ ctx, width, height, colors:{bg,fg,mid,dim} }` — the mono LCD palette; ignore it and paint in colour if you prefer, as the demo does |
| `api.invalidate()` | request a repaint |
| `api.exit()` | shut down, hand the LCD back |
| `api.battery()` | `0.0`–`1.0` |
| `api.signal()` | `0`–`4` bars |
| `api.now()` | a `Date` |

### Key events

Every key fires three events: `keydown`, `keyup`, then `press`.

```js
{
  type: 'press',      // 'keydown' | 'keyup' | 'press'
  key: 'sin',         // canonical id, e.g. '7', 'exe', 'ac', 'up', 'shift'
  shift: false,       // latch state at the time
  alpha: false,
  hyp: false,
  duration: 92,       // ms held (keyup/press only)
  time: 1726660000000
}
```

You can also tap the stream from anywhere, without being the OS:

```js
const stop = window.CASIO.keys.subscribe(ev => console.log(ev));
window.CASIO.keys.state();   // { shift, alpha, hyp }
stop();                      // unsubscribe
```

---

## The demo OS

**Homescreen** — clock, signal bars, a battery gauge that turns amber then
red as it drains, and app tiles with icon chips. `◀ ▶` to select, `EXE` to
open, `AC` or `ON` to leave.

The whole OS paints on a dark gradient with a teal accent; formula lines
are blue and final answers sit in a green panel.

**TriFind** — solve any triangle and show the working the way you'd
write it in an exam.

Fill in any three of: sides `a` `b` `c`, angles `A` `B` `C`, and the area.
You don't need all of them. Then pick what you want to find.

Standard labelling: side `a` is opposite angle `A`.

The solver applies, repeatedly, whichever rule now has enough inputs:
angle sum of triangle, the sine formula, the cosine formula (both
directions), `½ab sin C`, Heron's formula, and the reverse of the area
formula. The output is the chain of steps that led to your answer:

```
1. By cosine formula
c² = a² + b² − 2ab cos ∠C
c² = 5² + 7² − 2(5)(7) cos 60°
c² = 39
c = 6.24 (cor. to 3 sig. fig.)

∴ side c = 6.24
```

Pick **Solve everything** to get every remaining value plus a summary.

Three angles with no side is reported as underdetermined, which it is —
that fixes the shape but not the size.

**AI** — ask questions about maths, chemistry, physics, ICT, or general
science. Use the **AI settings** button below the calculator to select
Google Gemini's free tier or an OpenRouter free model and store its key in
the website's local storage. The key is not part of calculator state. Inside
the AI app, use **left** for camera capture and OCR, **Shift + Alpha** for
English text input, and **EXE** to send the question.

### Adding an app

An app is an object with `enter()`, `key(ev)`, and `render(ctx)`. Push it
onto `APPS` near the bottom of `os.js` and a tile appears on the
homescreen:

```js
var Clock = {
  id: 'clock', title: 'Clock', icon: '\u23F1', blurb: 'Big digits',
  enter() {},
  key(e) { if (e.type === 'press' && e.key === 'ac') OS.goHome(); },
  render(ctx) {
    text(ctx, api.now().toLocaleTimeString(), 20, 80, 48, COL.fg, 'bold');
  }
};
var APPS = [TriangleFind, About, Clock];
```
