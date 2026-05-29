// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;

// node_modules/sisteransi/src/index.js
var require_src = __commonJS((exports, module) => {
  var ESC2 = "\x1B";
  var CSI2 = `${ESC2}[`;
  var beep = "\x07";
  var cursor = {
    to(x, y) {
      if (!y)
        return `${CSI2}${x + 1}G`;
      return `${CSI2}${y + 1};${x + 1}H`;
    },
    move(x, y) {
      let ret = "";
      if (x < 0)
        ret += `${CSI2}${-x}D`;
      else if (x > 0)
        ret += `${CSI2}${x}C`;
      if (y < 0)
        ret += `${CSI2}${-y}A`;
      else if (y > 0)
        ret += `${CSI2}${y}B`;
      return ret;
    },
    up: (count = 1) => `${CSI2}${count}A`,
    down: (count = 1) => `${CSI2}${count}B`,
    forward: (count = 1) => `${CSI2}${count}C`,
    backward: (count = 1) => `${CSI2}${count}D`,
    nextLine: (count = 1) => `${CSI2}E`.repeat(count),
    prevLine: (count = 1) => `${CSI2}F`.repeat(count),
    left: `${CSI2}G`,
    hide: `${CSI2}?25l`,
    show: `${CSI2}?25h`,
    save: `${ESC2}7`,
    restore: `${ESC2}8`
  };
  var scroll = {
    up: (count = 1) => `${CSI2}S`.repeat(count),
    down: (count = 1) => `${CSI2}T`.repeat(count)
  };
  var erase = {
    screen: `${CSI2}2J`,
    up: (count = 1) => `${CSI2}1J`.repeat(count),
    down: (count = 1) => `${CSI2}J`.repeat(count),
    line: `${CSI2}2K`,
    lineEnd: `${CSI2}K`,
    lineStart: `${CSI2}1K`,
    lines(count) {
      let clear = "";
      for (let i = 0;i < count; i++)
        clear += this.line + (i < count - 1 ? cursor.up() : "");
      if (count)
        clear += cursor.left;
      return clear;
    }
  };
  module.exports = { cursor, scroll, erase, beep };
});

// node_modules/@clack/core/dist/index.mjs
import { styleText as v } from "util";
import { stdout as x, stdin as D } from "process";
import E from "readline";

// node_modules/fast-string-truncated-width/dist/utils.js
var getCodePointsLength = (() => {
  const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
  return (input) => {
    let surrogatePairsNr = 0;
    SURROGATE_PAIR_RE.lastIndex = 0;
    while (SURROGATE_PAIR_RE.test(input)) {
      surrogatePairsNr += 1;
    }
    return input.length - surrogatePairsNr;
  };
})();
var isFullWidth = (x) => {
  return x === 12288 || x >= 65281 && x <= 65376 || x >= 65504 && x <= 65510;
};
var isWideNotCJKTNotEmoji = (x) => {
  return x === 8987 || x === 9001 || x >= 12272 && x <= 12287 || x >= 12289 && x <= 12350 || x >= 12441 && x <= 12543 || x >= 12549 && x <= 12591 || x >= 12593 && x <= 12686 || x >= 12688 && x <= 12771 || x >= 12783 && x <= 12830 || x >= 12832 && x <= 12871 || x >= 12880 && x <= 19903 || x >= 65040 && x <= 65049 || x >= 65072 && x <= 65106 || x >= 65108 && x <= 65126 || x >= 65128 && x <= 65131 || x >= 127488 && x <= 127490 || x >= 127504 && x <= 127547 || x >= 127552 && x <= 127560 || x >= 131072 && x <= 196605 || x >= 196608 && x <= 262141;
};

// node_modules/fast-string-truncated-width/dist/index.js
var ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\]8;[^;]*;.*?(?:\u0007|\u001b\u005c)/y;
var CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var CJKT_WIDE_RE = /(?:(?![\uFF61-\uFF9F\uFF00-\uFFEF])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tangut}]){1,1000}/yu;
var TAB_RE = /\t{1,1000}/y;
var EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/yu;
var LATIN_RE = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var MODIFIER_RE = /\p{M}+/gu;
var NO_TRUNCATION = { limit: Infinity, ellipsis: "" };
var getStringTruncatedWidth = (input, truncationOptions = {}, widthOptions = {}) => {
  const LIMIT = truncationOptions.limit ?? Infinity;
  const ELLIPSIS = truncationOptions.ellipsis ?? "";
  const ELLIPSIS_WIDTH = truncationOptions?.ellipsisWidth ?? (ELLIPSIS ? getStringTruncatedWidth(ELLIPSIS, NO_TRUNCATION, widthOptions).width : 0);
  const ANSI_WIDTH = 0;
  const CONTROL_WIDTH = widthOptions.controlWidth ?? 0;
  const TAB_WIDTH = widthOptions.tabWidth ?? 8;
  const EMOJI_WIDTH = widthOptions.emojiWidth ?? 2;
  const FULL_WIDTH_WIDTH = 2;
  const REGULAR_WIDTH = widthOptions.regularWidth ?? 1;
  const WIDE_WIDTH = widthOptions.wideWidth ?? FULL_WIDTH_WIDTH;
  const PARSE_BLOCKS = [
    [LATIN_RE, REGULAR_WIDTH],
    [ANSI_RE, ANSI_WIDTH],
    [CONTROL_RE, CONTROL_WIDTH],
    [TAB_RE, TAB_WIDTH],
    [EMOJI_RE, EMOJI_WIDTH],
    [CJKT_WIDE_RE, WIDE_WIDTH]
  ];
  let indexPrev = 0;
  let index = 0;
  let length = input.length;
  let lengthExtra = 0;
  let truncationEnabled = false;
  let truncationIndex = length;
  let truncationLimit = Math.max(0, LIMIT - ELLIPSIS_WIDTH);
  let unmatchedStart = 0;
  let unmatchedEnd = 0;
  let width = 0;
  let widthExtra = 0;
  outer:
    while (true) {
      if (unmatchedEnd > unmatchedStart || index >= length && index > indexPrev) {
        const unmatched = input.slice(unmatchedStart, unmatchedEnd) || input.slice(indexPrev, index);
        lengthExtra = 0;
        for (const char of unmatched.replaceAll(MODIFIER_RE, "")) {
          const codePoint = char.codePointAt(0) || 0;
          if (isFullWidth(codePoint)) {
            widthExtra = FULL_WIDTH_WIDTH;
          } else if (isWideNotCJKTNotEmoji(codePoint)) {
            widthExtra = WIDE_WIDTH;
          } else {
            widthExtra = REGULAR_WIDTH;
          }
          if (width + widthExtra > truncationLimit) {
            truncationIndex = Math.min(truncationIndex, Math.max(unmatchedStart, indexPrev) + lengthExtra);
          }
          if (width + widthExtra > LIMIT) {
            truncationEnabled = true;
            break outer;
          }
          lengthExtra += char.length;
          width += widthExtra;
        }
        unmatchedStart = unmatchedEnd = 0;
      }
      if (index >= length) {
        break outer;
      }
      for (let i = 0, l = PARSE_BLOCKS.length;i < l; i++) {
        const [BLOCK_RE, BLOCK_WIDTH] = PARSE_BLOCKS[i];
        BLOCK_RE.lastIndex = index;
        if (BLOCK_RE.test(input)) {
          lengthExtra = BLOCK_RE === CJKT_WIDE_RE ? getCodePointsLength(input.slice(index, BLOCK_RE.lastIndex)) : BLOCK_RE === EMOJI_RE ? 1 : BLOCK_RE.lastIndex - index;
          widthExtra = lengthExtra * BLOCK_WIDTH;
          if (width + widthExtra > truncationLimit) {
            truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / BLOCK_WIDTH));
          }
          if (width + widthExtra > LIMIT) {
            truncationEnabled = true;
            break outer;
          }
          width += widthExtra;
          unmatchedStart = indexPrev;
          unmatchedEnd = index;
          index = indexPrev = BLOCK_RE.lastIndex;
          continue outer;
        }
      }
      index += 1;
    }
  return {
    width: truncationEnabled ? truncationLimit : width,
    index: truncationEnabled ? truncationIndex : length,
    truncated: truncationEnabled,
    ellipsed: truncationEnabled && LIMIT >= ELLIPSIS_WIDTH
  };
};
var dist_default = getStringTruncatedWidth;

// node_modules/fast-string-width/dist/index.js
var NO_TRUNCATION2 = {
  limit: Infinity,
  ellipsis: "",
  ellipsisWidth: 0
};
var fastStringWidth = (input, options = {}) => {
  return dist_default(input, NO_TRUNCATION2, options).width;
};
var dist_default2 = fastStringWidth;

// node_modules/fast-wrap-ansi/lib/main.js
var ESC = "\x1B";
var CSI = "\x9B";
var END_CODE = 39;
var ANSI_ESCAPE_BELL = "\x07";
var ANSI_CSI = "[";
var ANSI_OSC = "]";
var ANSI_SGR_TERMINATOR = "m";
var ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;
var GROUP_REGEX = new RegExp(`(?:\\${ANSI_CSI}(?<code>\\d+)m|\\${ANSI_ESCAPE_LINK}(?<uri>.*)${ANSI_ESCAPE_BELL})`, "y");
var getClosingCode = (openingCode) => {
  if (openingCode >= 30 && openingCode <= 37)
    return 39;
  if (openingCode >= 90 && openingCode <= 97)
    return 39;
  if (openingCode >= 40 && openingCode <= 47)
    return 49;
  if (openingCode >= 100 && openingCode <= 107)
    return 49;
  if (openingCode === 1 || openingCode === 2)
    return 22;
  if (openingCode === 3)
    return 23;
  if (openingCode === 4)
    return 24;
  if (openingCode === 7)
    return 27;
  if (openingCode === 8)
    return 28;
  if (openingCode === 9)
    return 29;
  if (openingCode === 0)
    return 0;
  return;
};
var wrapAnsiCode = (code) => `${ESC}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`;
var wrapAnsiHyperlink = (url) => `${ESC}${ANSI_ESCAPE_LINK}${url}${ANSI_ESCAPE_BELL}`;
var wrapWord = (rows, word, columns) => {
  const characters = word[Symbol.iterator]();
  let isInsideEscape = false;
  let isInsideLinkEscape = false;
  let lastRow = rows.at(-1);
  let visible = lastRow === undefined ? 0 : dist_default2(lastRow);
  let currentCharacter = characters.next();
  let nextCharacter = characters.next();
  let rawCharacterIndex = 0;
  while (!currentCharacter.done) {
    const character = currentCharacter.value;
    const characterLength = dist_default2(character);
    if (visible + characterLength <= columns) {
      rows[rows.length - 1] += character;
    } else {
      rows.push(character);
      visible = 0;
    }
    if (character === ESC || character === CSI) {
      isInsideEscape = true;
      isInsideLinkEscape = word.startsWith(ANSI_ESCAPE_LINK, rawCharacterIndex + 1);
    }
    if (isInsideEscape) {
      if (isInsideLinkEscape) {
        if (character === ANSI_ESCAPE_BELL) {
          isInsideEscape = false;
          isInsideLinkEscape = false;
        }
      } else if (character === ANSI_SGR_TERMINATOR) {
        isInsideEscape = false;
      }
    } else {
      visible += characterLength;
      if (visible === columns && !nextCharacter.done) {
        rows.push("");
        visible = 0;
      }
    }
    currentCharacter = nextCharacter;
    nextCharacter = characters.next();
    rawCharacterIndex += character.length;
  }
  lastRow = rows.at(-1);
  if (!visible && lastRow !== undefined && lastRow.length && rows.length > 1) {
    rows[rows.length - 2] += rows.pop();
  }
};
var stringVisibleTrimSpacesRight = (string) => {
  const words = string.split(" ");
  let last = words.length;
  while (last) {
    if (dist_default2(words[last - 1])) {
      break;
    }
    last--;
  }
  if (last === words.length) {
    return string;
  }
  return words.slice(0, last).join(" ") + words.slice(last).join("");
};
var exec = (string, columns, options = {}) => {
  if (options.trim !== false && string.trim() === "") {
    return "";
  }
  let returnValue = "";
  let escapeCode;
  let escapeUrl;
  const words = string.split(" ");
  let rows = [""];
  let rowLength = 0;
  for (let index = 0;index < words.length; index++) {
    const word = words[index];
    if (options.trim !== false) {
      const row = rows.at(-1) ?? "";
      const trimmed = row.trimStart();
      if (row.length !== trimmed.length) {
        rows[rows.length - 1] = trimmed;
        rowLength = dist_default2(trimmed);
      }
    }
    if (index !== 0) {
      if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
        rows.push("");
        rowLength = 0;
      }
      if (rowLength || options.trim === false) {
        rows[rows.length - 1] += " ";
        rowLength++;
      }
    }
    const wordLength = dist_default2(word);
    if (options.hard && wordLength > columns) {
      const remainingColumns = columns - rowLength;
      const breaksStartingThisLine = 1 + Math.floor((wordLength - remainingColumns - 1) / columns);
      const breaksStartingNextLine = Math.floor((wordLength - 1) / columns);
      if (breaksStartingNextLine < breaksStartingThisLine) {
        rows.push("");
      }
      wrapWord(rows, word, columns);
      rowLength = dist_default2(rows.at(-1) ?? "");
      continue;
    }
    if (rowLength + wordLength > columns && rowLength && wordLength) {
      if (options.wordWrap === false && rowLength < columns) {
        wrapWord(rows, word, columns);
        rowLength = dist_default2(rows.at(-1) ?? "");
        continue;
      }
      rows.push("");
      rowLength = 0;
    }
    if (rowLength + wordLength > columns && options.wordWrap === false) {
      wrapWord(rows, word, columns);
      rowLength = dist_default2(rows.at(-1) ?? "");
      continue;
    }
    rows[rows.length - 1] += word;
    rowLength += wordLength;
  }
  if (options.trim !== false) {
    rows = rows.map((row) => stringVisibleTrimSpacesRight(row));
  }
  const preString = rows.join(`
`);
  let inSurrogate = false;
  for (let i = 0;i < preString.length; i++) {
    const character = preString[i];
    returnValue += character;
    if (!inSurrogate) {
      inSurrogate = character >= "\uD800" && character <= "\uDBFF";
      if (inSurrogate) {
        continue;
      }
    } else {
      inSurrogate = false;
    }
    if (character === ESC || character === CSI) {
      GROUP_REGEX.lastIndex = i + 1;
      const groupsResult = GROUP_REGEX.exec(preString);
      const groups = groupsResult?.groups;
      if (groups?.code !== undefined) {
        const code = Number.parseFloat(groups.code);
        escapeCode = code === END_CODE ? undefined : code;
      } else if (groups?.uri !== undefined) {
        escapeUrl = groups.uri.length === 0 ? undefined : groups.uri;
      }
    }
    if (preString[i + 1] === `
`) {
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink("");
      }
      const closingCode = escapeCode ? getClosingCode(escapeCode) : undefined;
      if (escapeCode && closingCode) {
        returnValue += wrapAnsiCode(closingCode);
      }
    } else if (character === `
`) {
      if (escapeCode && getClosingCode(escapeCode)) {
        returnValue += wrapAnsiCode(escapeCode);
      }
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink(escapeUrl);
      }
    }
  }
  return returnValue;
};
var CRLF_OR_LF = /\r?\n/;
function wrapAnsi(string, columns, options) {
  return String(string).normalize().split(CRLF_OR_LF).map((line) => exec(line, columns, options)).join(`
`);
}

// node_modules/@clack/core/dist/index.mjs
var import_sisteransi = __toESM(require_src(), 1);
function f(r, t, s) {
  if (!s.some((o) => !o.disabled))
    return r;
  const e = r + t, i = Math.max(s.length - 1, 0), n = e < 0 ? i : e > i ? 0 : e;
  return s[n].disabled ? f(n, t < 0 ? -1 : 1, s) : n;
}
function I(r, t, s, e) {
  const i = e.split(`
`);
  let n = 0, o = r;
  for (const a of i) {
    if (o <= a.length)
      break;
    o -= a.length + 1, n++;
  }
  for (n = Math.max(0, Math.min(i.length - 1, n + s)), o = Math.min(o, i[n].length) + t;o < 0 && n > 0; )
    n--, o += i[n].length + 1;
  for (;o > i[n].length && n < i.length - 1; )
    o -= i[n].length + 1, n++;
  o = Math.max(0, Math.min(i[n].length, o));
  let u = 0;
  for (let a = 0;a < n; a++)
    u += i[a].length + 1;
  return u + o;
}
var G = ["up", "down", "left", "right", "space", "enter", "cancel"];
var K = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var h = { actions: new Set(G), aliases: new Map([["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["\x03", "cancel"], ["escape", "cancel"]]), messages: { cancel: "Canceled", error: "Something went wrong" }, withGuide: true, date: { monthNames: [...K], messages: { required: "Please enter a valid date", invalidMonth: "There are only 12 months in a year", invalidDay: (r, t) => `There are only ${r} days in ${t}`, afterMin: (r) => `Date must be on or after ${r.toISOString().slice(0, 10)}`, beforeMax: (r) => `Date must be on or before ${r.toISOString().slice(0, 10)}` } } };
function C(r, t) {
  if (typeof r == "string")
    return h.aliases.get(r) === t;
  for (const s of r)
    if (s !== undefined && C(s, t))
      return true;
  return false;
}
function z(r, t) {
  if (r === t)
    return;
  const s = r.split(`
`), e = t.split(`
`), i = Math.max(s.length, e.length), n = [];
  for (let o = 0;o < i; o++)
    s[o] !== e[o] && n.push(o);
  return { lines: n, numLinesBefore: s.length, numLinesAfter: e.length, numLines: i };
}
var Y = globalThis.process.platform.startsWith("win");
var k = Symbol("clack:cancel");
function q(r) {
  return r === k;
}
function w(r, t) {
  const s = r;
  s.isTTY && s.setRawMode(t);
}
var A = (r) => ("columns" in r) && typeof r.columns == "number" ? r.columns : 80;
var L = (r) => ("rows" in r) && typeof r.rows == "number" ? r.rows : 20;
function W(r, t, s, e = s, i = s, n) {
  const o = A(r ?? x);
  return wrapAnsi(t, o - s.length, { hard: true, trim: false }).split(`
`).map((u, a, l) => {
    const c = n ? n(u, a) : u;
    return a === 0 ? `${e}${c}` : a === l.length - 1 ? `${i}${c}` : `${s}${c}`;
  }).join(`
`);
}
var m = class {
  input;
  output;
  _abortSignal;
  rl;
  opts;
  _render;
  _track = false;
  _prevFrame = "";
  _subscribers = new Map;
  _cursor = 0;
  state = "initial";
  error = "";
  value;
  userInput = "";
  constructor(t, s = true) {
    const { input: e = D, output: i = x, render: n, signal: o, ...u } = t;
    this.opts = u, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = n.bind(this), this._track = s, this._abortSignal = o, this.input = e, this.output = i;
  }
  unsubscribe() {
    this._subscribers.clear();
  }
  setSubscriber(t, s) {
    const e = this._subscribers.get(t) ?? [];
    e.push(s), this._subscribers.set(t, e);
  }
  on(t, s) {
    this.setSubscriber(t, { cb: s });
  }
  once(t, s) {
    this.setSubscriber(t, { cb: s, once: true });
  }
  emit(t, ...s) {
    const e = this._subscribers.get(t) ?? [], i = [];
    for (const n of e)
      n.cb(...s), n.once && i.push(() => e.splice(e.indexOf(n), 1));
    for (const n of i)
      n();
  }
  prompt() {
    return new Promise((t) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted)
          return this.state = "cancel", this.close(), t(k);
        this._abortSignal.addEventListener("abort", () => {
          this.state = "cancel", this.close();
        }, { once: true });
      }
      this.rl = E.createInterface({ input: this.input, tabSize: 2, prompt: "", escapeCodeTimeout: 50, terminal: true }), this.rl.prompt(), this.opts.initialUserInput !== undefined && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), w(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), w(this.input, false), t(this.value);
      }), this.once("cancel", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), w(this.input, false), t(k);
      });
    });
  }
  _isActionKey(t, s) {
    return t === "\t";
  }
  _shouldSubmit(t, s) {
    return true;
  }
  _setValue(t) {
    this.value = t, this.emit("value", this.value);
  }
  _setUserInput(t, s) {
    this.userInput = t ?? "", this.emit("userInput", this.userInput), s && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
  }
  _clearUserInput() {
    this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
  }
  onKeypress(t, s) {
    if (this._track && s.name !== "return" && (s.name && this._isActionKey(t, s) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), s?.name && (!this._track && h.aliases.has(s.name) && this.emit("cursor", h.aliases.get(s.name)), h.actions.has(s.name) && this.emit("cursor", s.name)), t && (t.toLowerCase() === "y" || t.toLowerCase() === "n") && this.emit("confirm", t.toLowerCase() === "y"), this.emit("key", t?.toLowerCase(), s), s?.name === "return" && this._shouldSubmit(t, s)) {
      if (this.opts.validate) {
        const e = this.opts.validate(this.value);
        e && (this.error = e instanceof Error ? e.message : e, this.state = "error", this.rl?.write(this.userInput));
      }
      this.state !== "error" && (this.state = "submit");
    }
    C([t, s?.name, s?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
  }
  close() {
    this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), w(this.input, false), this.rl?.close(), this.rl = undefined, this.emit(`${this.state}`, this.value), this.unsubscribe();
  }
  restoreCursor() {
    const t = wrapAnsi(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, t * -1));
  }
  render() {
    const t = wrapAnsi(this._render(this) ?? "", process.stdout.columns, { hard: true, trim: false });
    if (t !== this._prevFrame) {
      if (this.state === "initial")
        this.output.write(import_sisteransi.cursor.hide);
      else {
        const s = z(this._prevFrame, t), e = L(this.output);
        if (this.restoreCursor(), s) {
          const i = Math.max(0, s.numLinesAfter - e), n = Math.max(0, s.numLinesBefore - e);
          let o = s.lines.find((u) => u >= i);
          if (o === undefined) {
            this._prevFrame = t;
            return;
          }
          if (s.lines.length === 1) {
            this.output.write(import_sisteransi.cursor.move(0, o - n)), this.output.write(import_sisteransi.erase.lines(1));
            const u = t.split(`
`);
            this.output.write(u[o]), this._prevFrame = t, this.output.write(import_sisteransi.cursor.move(0, u.length - o - 1));
            return;
          } else if (s.lines.length > 1) {
            if (i < n)
              o = i;
            else {
              const a = o - n;
              a > 0 && this.output.write(import_sisteransi.cursor.move(0, a));
            }
            this.output.write(import_sisteransi.erase.down());
            const u = t.split(`
`).slice(o);
            this.output.write(u.join(`
`)), this._prevFrame = t;
            return;
          }
        }
        this.output.write(import_sisteransi.erase.down());
      }
      this.output.write(t), this.state === "initial" && (this.state = "active"), this._prevFrame = t;
    }
  }
};
function B(r, t) {
  if (r === undefined || t.length === 0)
    return 0;
  const s = t.findIndex((e) => e.value === r);
  return s !== -1 ? s : 0;
}
function J(r, t) {
  return (t.label ?? String(t.value)).toLowerCase().includes(r.toLowerCase());
}
function H(r, t) {
  if (t)
    return r ? t : t[0];
}
var Q = class extends m {
  filteredOptions;
  multiple;
  isNavigating = false;
  selectedValues = [];
  focusedValue;
  #s = 0;
  #r = "";
  #t;
  #n;
  #u;
  get cursor() {
    return this.#s;
  }
  get userInputWithCursor() {
    if (!this.userInput)
      return v(["inverse", "hidden"], "_");
    if (this._cursor >= this.userInput.length)
      return `${this.userInput}\u2588`;
    const t = this.userInput.slice(0, this._cursor), [s, ...e] = this.userInput.slice(this._cursor);
    return `${t}${v("inverse", s)}${e.join("")}`;
  }
  get options() {
    return typeof this.#n == "function" ? this.#n() : this.#n;
  }
  constructor(t) {
    super(t), this.#n = t.options, this.#u = t.placeholder;
    const s = this.options;
    this.filteredOptions = [...s], this.multiple = t.multiple === true, this.#t = typeof t.options == "function" ? t.filter : t.filter ?? J;
    let e;
    if (t.initialValue && Array.isArray(t.initialValue) ? this.multiple ? e = t.initialValue : e = t.initialValue.slice(0, 1) : !this.multiple && this.options.length > 0 && (e = [this.options[0].value]), e)
      for (const i of e) {
        const n = s.findIndex((o) => o.value === i);
        n !== -1 && (this.toggleSelected(i), this.#s = n);
      }
    this.focusedValue = this.options[this.#s]?.value, this.on("key", (i, n) => this.#e(i, n)), this.on("userInput", (i) => this.#i(i));
  }
  _isActionKey(t, s) {
    return t === "\t" || this.multiple && this.isNavigating && s.name === "space" && t !== undefined && t !== "";
  }
  #e(t, s) {
    const e = s.name === "up", i = s.name === "down", n = s.name === "return", o = this.userInput === "" || this.userInput === "\t", u = this.#u, a = this.options, l = u !== undefined && u !== "" && a.some((c) => !c.disabled && (this.#t ? this.#t(u, c) : true));
    if (s.name === "tab" && o && l) {
      this.userInput === "\t" && this._clearUserInput(), this._setUserInput(u, true), this.isNavigating = false;
      return;
    }
    e || i ? (this.#s = f(this.#s, e ? -1 : 1, this.filteredOptions), this.focusedValue = this.filteredOptions[this.#s]?.value, this.multiple || (this.selectedValues = [this.focusedValue]), this.isNavigating = true) : n ? this.value = H(this.multiple, this.selectedValues) : this.multiple ? this.focusedValue !== undefined && (s.name === "tab" || this.isNavigating && s.name === "space") ? this.toggleSelected(this.focusedValue) : this.isNavigating = false : (this.focusedValue && (this.selectedValues = [this.focusedValue]), this.isNavigating = false);
  }
  deselectAll() {
    this.selectedValues = [];
  }
  toggleSelected(t) {
    this.filteredOptions.length !== 0 && (this.multiple ? this.selectedValues.includes(t) ? this.selectedValues = this.selectedValues.filter((s) => s !== t) : this.selectedValues = [...this.selectedValues, t] : this.selectedValues = [t]);
  }
  #i(t) {
    if (t !== this.#r) {
      this.#r = t;
      const s = this.options;
      t && this.#t ? this.filteredOptions = s.filter((n) => this.#t?.(t, n)) : this.filteredOptions = [...s];
      const e = B(this.focusedValue, this.filteredOptions);
      this.#s = f(e, 0, this.filteredOptions);
      const i = this.filteredOptions[this.#s];
      i && !i.disabled ? this.focusedValue = i.value : this.focusedValue = undefined, this.multiple || (this.focusedValue !== undefined ? this.toggleSelected(this.focusedValue) : this.deselectAll());
    }
  }
};
var Z = { Y: { type: "year", len: 4 }, M: { type: "month", len: 2 }, D: { type: "day", len: 2 } };
function P(r) {
  return [...r].map((t) => Z[t]);
}
function tt(r) {
  const t = new Intl.DateTimeFormat(r, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(2000, 0, 15)), s = [];
  let e = "/";
  for (const i of t)
    i.type === "literal" ? e = i.value.trim() || i.value : (i.type === "year" || i.type === "month" || i.type === "day") && s.push({ type: i.type, len: i.type === "year" ? 4 : 2 });
  return { segments: s, separator: e };
}
function $(r) {
  return Number.parseInt((r || "0").replace(/_/g, "0"), 10) || 0;
}
function S(r) {
  return { year: $(r.year), month: $(r.month), day: $(r.day) };
}
function U(r, t) {
  return new Date(r || 2001, t || 1, 0).getDate();
}
function F(r) {
  const { year: t, month: s, day: e } = S(r);
  if (!t || t < 0 || t > 9999 || !s || s < 1 || s > 12 || !e || e < 1)
    return;
  const i = new Date(Date.UTC(t, s - 1, e));
  if (!(i.getUTCFullYear() !== t || i.getUTCMonth() !== s - 1 || i.getUTCDate() !== e))
    return { year: t, month: s, day: e };
}
function N(r) {
  const t = F(r);
  return t ? new Date(Date.UTC(t.year, t.month - 1, t.day)) : undefined;
}
function st(r, t, s, e) {
  const i = s ? { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() } : null, n = e ? { year: e.getUTCFullYear(), month: e.getUTCMonth() + 1, day: e.getUTCDate() } : null;
  return r === "year" ? { min: i?.year ?? 1, max: n?.year ?? 9999 } : r === "month" ? { min: i && t.year === i.year ? i.month : 1, max: n && t.year === n.year ? n.month : 12 } : { min: i && t.year === i.year && t.month === i.month ? i.day : 1, max: n && t.year === n.year && t.month === n.month ? n.day : U(t.year, t.month) };
}

class et extends m {
  #s;
  #r;
  #t;
  #n;
  #u;
  #e = { segmentIndex: 0, positionInSegment: 0 };
  #i = true;
  #o = null;
  inlineError = "";
  get segmentCursor() {
    return { ...this.#e };
  }
  get segmentValues() {
    return { ...this.#t };
  }
  get segments() {
    return this.#s;
  }
  get separator() {
    return this.#r;
  }
  get formattedValue() {
    return this.#c(this.#t);
  }
  #c(t) {
    return this.#s.map((s) => t[s.type]).join(this.#r);
  }
  #a() {
    this._setUserInput(this.#c(this.#t)), this._setValue(N(this.#t) ?? undefined);
  }
  constructor(t) {
    const s = t.format ? { segments: P(t.format), separator: t.separator ?? "/" } : tt(t.locale), e = t.separator ?? s.separator, i = t.format ? P(t.format) : s.segments, n = t.initialValue ?? t.defaultValue, o = n ? { year: String(n.getUTCFullYear()).padStart(4, "0"), month: String(n.getUTCMonth() + 1).padStart(2, "0"), day: String(n.getUTCDate()).padStart(2, "0") } : { year: "____", month: "__", day: "__" }, u = i.map((a) => o[a.type]).join(e);
    super({ ...t, initialUserInput: u }, false), this.#s = i, this.#r = e, this.#t = o, this.#n = t.minDate, this.#u = t.maxDate, this.#a(), this.on("cursor", (a) => this.#d(a)), this.on("key", (a, l) => this.#f(a, l)), this.on("finalize", () => this.#g(t));
  }
  #h() {
    const t = Math.max(0, Math.min(this.#e.segmentIndex, this.#s.length - 1)), s = this.#s[t];
    if (s)
      return this.#e.positionInSegment = Math.max(0, Math.min(this.#e.positionInSegment, s.len - 1)), { segment: s, index: t };
  }
  #l(t) {
    this.inlineError = "", this.#o = null;
    const s = this.#h();
    s && (this.#e.segmentIndex = Math.max(0, Math.min(this.#s.length - 1, s.index + t)), this.#e.positionInSegment = 0, this.#i = true);
  }
  #p(t) {
    const s = this.#h();
    if (!s)
      return;
    const { segment: e } = s, i = this.#t[e.type], n = !i || i.replace(/_/g, "") === "", o = Number.parseInt((i || "0").replace(/_/g, "0"), 10) || 0, u = st(e.type, S(this.#t), this.#n, this.#u);
    let a;
    n ? a = t === 1 ? u.min : u.max : a = Math.max(Math.min(u.max, o + t), u.min), this.#t = { ...this.#t, [e.type]: a.toString().padStart(e.len, "0") }, this.#i = true, this.#o = null, this.#a();
  }
  #d(t) {
    if (t)
      switch (t) {
        case "right":
          return this.#l(1);
        case "left":
          return this.#l(-1);
        case "up":
          return this.#p(1);
        case "down":
          return this.#p(-1);
      }
  }
  #f(t, s) {
    if (s?.name === "backspace" || s?.sequence === "\x7F" || s?.sequence === "\b" || t === "\x7F" || t === "\b") {
      this.inlineError = "";
      const e = this.#h();
      if (!e)
        return;
      if (!this.#t[e.segment.type].replace(/_/g, "")) {
        this.#l(-1);
        return;
      }
      this.#t[e.segment.type] = "_".repeat(e.segment.len), this.#i = true, this.#e.positionInSegment = 0, this.#a();
      return;
    }
    if (s?.name === "tab") {
      this.inlineError = "";
      const e = this.#h();
      if (!e)
        return;
      const i = s.shift ? -1 : 1, n = e.index + i;
      n >= 0 && n < this.#s.length && (this.#e.segmentIndex = n, this.#e.positionInSegment = 0, this.#i = true);
      return;
    }
    if (t && /^[0-9]$/.test(t)) {
      const e = this.#h();
      if (!e)
        return;
      const { segment: i } = e, n = !this.#t[i.type].replace(/_/g, "");
      if (this.#i && this.#o !== null && !n) {
        const d = this.#o + t, g = { ...this.#t, [i.type]: d }, _ = this.#m(g, i);
        if (_) {
          this.inlineError = _, this.#o = null, this.#i = false;
          return;
        }
        this.inlineError = "", this.#t[i.type] = d, this.#o = null, this.#i = false, this.#a(), e.index < this.#s.length - 1 && (this.#e.segmentIndex = e.index + 1, this.#e.positionInSegment = 0, this.#i = true);
        return;
      }
      this.#i && !n && (this.#t[i.type] = "_".repeat(i.len), this.#e.positionInSegment = 0), this.#i = false, this.#o = null;
      const o = this.#t[i.type], u = o.indexOf("_"), a = u >= 0 ? u : Math.min(this.#e.positionInSegment, i.len - 1);
      if (a < 0 || a >= i.len)
        return;
      let l = o.slice(0, a) + t + o.slice(a + 1), c = false;
      if (a === 0 && o === "__" && (i.type === "month" || i.type === "day")) {
        const d = Number.parseInt(t, 10);
        l = `0${t}`, c = d <= (i.type === "month" ? 1 : 2);
      }
      if (i.type === "year" && (l = (o.replace(/_/g, "") + t).padStart(i.len, "_")), !l.includes("_")) {
        const d = { ...this.#t, [i.type]: l }, g = this.#m(d, i);
        if (g) {
          this.inlineError = g;
          return;
        }
      }
      this.inlineError = "", this.#t[i.type] = l;
      const y = l.includes("_") ? undefined : F(this.#t);
      if (y) {
        const { year: d, month: g } = y, _ = U(d, g);
        this.#t = { year: String(Math.max(0, Math.min(9999, d))).padStart(4, "0"), month: String(Math.max(1, Math.min(12, g))).padStart(2, "0"), day: String(Math.max(1, Math.min(_, y.day))).padStart(2, "0") };
      }
      this.#a();
      const T = l.indexOf("_");
      c ? (this.#i = true, this.#o = t) : T >= 0 ? this.#e.positionInSegment = T : u >= 0 && e.index < this.#s.length - 1 ? (this.#e.segmentIndex = e.index + 1, this.#e.positionInSegment = 0, this.#i = true) : this.#e.positionInSegment = Math.min(a + 1, i.len - 1);
    }
  }
  #m(t, s) {
    const { month: e, day: i } = S(t);
    if (s.type === "month" && (e < 0 || e > 12))
      return h.date.messages.invalidMonth;
    if (s.type === "day" && (i < 0 || i > 31))
      return h.date.messages.invalidDay(31, "any month");
  }
  #g(t) {
    const { year: s, month: e, day: i } = S(this.#t);
    if (s && e && i) {
      const n = U(s, e);
      this.#t = { ...this.#t, day: String(Math.min(i, n)).padStart(2, "0") };
    }
    this.value = N(this.#t) ?? t.defaultValue ?? undefined;
  }
}

class it extends m {
  options;
  cursor = 0;
  #s;
  getGroupItems(t) {
    return this.options.filter((s) => s.group === t);
  }
  isGroupSelected(t) {
    const s = this.getGroupItems(t), e = this.value;
    return e === undefined ? false : s.every((i) => e.includes(i.value));
  }
  toggleValue() {
    const t = this.options[this.cursor];
    if (this.value === undefined && (this.value = []), t.group === true) {
      const s = t.value, e = this.getGroupItems(s);
      this.isGroupSelected(s) ? this.value = this.value.filter((i) => e.findIndex((n) => n.value === i) === -1) : this.value = [...this.value, ...e.map((i) => i.value)], this.value = Array.from(new Set(this.value));
    } else {
      const s = this.value.includes(t.value);
      this.value = s ? this.value.filter((e) => e !== t.value) : [...this.value, t.value];
    }
  }
  constructor(t) {
    super(t, false);
    const { options: s } = t;
    this.#s = t.selectableGroups !== false, this.options = Object.entries(s).flatMap(([e, i]) => [{ value: e, group: true, label: e }, ...i.map((n) => ({ ...n, group: e }))]), this.value = [...t.initialValues ?? []], this.cursor = Math.max(this.options.findIndex(({ value: e }) => e === t.cursorAt), this.#s ? 0 : 1), this.on("cursor", (e) => {
      switch (e) {
        case "left":
        case "up": {
          this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
          const i = this.options[this.cursor]?.group === true;
          !this.#s && i && (this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1);
          break;
        }
        case "down":
        case "right": {
          this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
          const i = this.options[this.cursor]?.group === true;
          !this.#s && i && (this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1);
          break;
        }
        case "space":
          this.toggleValue();
          break;
      }
    });
  }
}

class rt extends m {
  #s = false;
  #r;
  focused = "editor";
  get userInputWithCursor() {
    if (this.state === "submit")
      return this.userInput;
    const t = this.userInput;
    if (this.cursor >= t.length)
      return `${t}\u2588`;
    const s = t.slice(0, this.cursor), e = t[this.cursor], i = t.slice(this.cursor + 1);
    return e === `
` ? `${s}\u2588
${i}` : `${s}${v("inverse", e)}${i}`;
  }
  get cursor() {
    return this._cursor;
  }
  #t(t) {
    if (this.userInput.length === 0) {
      this._setUserInput(t);
      return;
    }
    this._setUserInput(this.userInput.slice(0, this.cursor) + t + this.userInput.slice(this.cursor));
  }
  #n(t) {
    const s = this.value ?? "";
    switch (t) {
      case "up":
        this._cursor = I(this._cursor, 0, -1, s);
        return;
      case "down":
        this._cursor = I(this._cursor, 0, 1, s);
        return;
      case "left":
        this._cursor = I(this._cursor, -1, 0, s);
        return;
      case "right":
        this._cursor = I(this._cursor, 1, 0, s);
        return;
    }
  }
  _shouldSubmit(t, s) {
    if (this.#r)
      return this.focused === "submit" ? true : (this.#t(`
`), this._cursor++, false);
    const e = this.#s;
    return this.#s = true, e ? (this.userInput[this.cursor - 1] === `
` && (this._setUserInput(this.userInput.slice(0, this.cursor - 1) + this.userInput.slice(this.cursor)), this._cursor--), true) : (this.#t(`
`), this._cursor++, false);
  }
  constructor(t) {
    super(t, false), this.#r = t.showSubmit ?? false, this.on("key", (s, e) => {
      if (e?.name && h.actions.has(e.name)) {
        this.#n(e.name);
        return;
      }
      if (s === "\t" && this.#r) {
        this.focused = this.focused === "editor" ? "submit" : "editor";
        return;
      }
      if (e?.name !== "return") {
        if (this.#s = false, e?.name === "backspace" && this.cursor > 0) {
          this._setUserInput(this.userInput.slice(0, this.cursor - 1) + this.userInput.slice(this.cursor)), this._cursor--;
          return;
        }
        if (e?.name === "delete" && this.cursor < this.userInput.length) {
          this._setUserInput(this.userInput.slice(0, this.cursor) + this.userInput.slice(this.cursor + 1));
          return;
        }
        s && (this.#r && this.focused === "submit" && (this.focused = "editor"), this.#t(s ?? ""), this._cursor++);
      }
    }), this.on("userInput", (s) => {
      this._setValue(s);
    }), this.on("finalize", () => {
      this.value || (this.value = t.defaultValue), this.value === undefined && (this.value = "");
    });
  }
}
class ut extends m {
  options;
  cursor = 0;
  get _selectedValue() {
    return this.options[this.cursor];
  }
  changeValue() {
    this.value = this._selectedValue.value;
  }
  constructor(t) {
    super(t, false), this.options = t.options;
    const s = this.options.findIndex(({ value: i }) => i === t.initialValue), e = s === -1 ? 0 : s;
    this.cursor = this.options[e].disabled ? f(e, 1, this.options) : e, this.changeValue(), this.on("cursor", (i) => {
      switch (i) {
        case "left":
        case "up":
          this.cursor = f(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = f(this.cursor, 1, this.options);
          break;
      }
      this.changeValue();
    });
  }
}
class ht extends m {
  get userInputWithCursor() {
    if (this.state === "submit")
      return this.userInput;
    const t = this.userInput;
    if (this.cursor >= t.length)
      return `${this.userInput}\u2588`;
    const s = t.slice(0, this.cursor), [e, ...i] = t.slice(this.cursor);
    return `${s}${v("inverse", e)}${i.join("")}`;
  }
  get cursor() {
    return this._cursor;
  }
  constructor(t) {
    super({ ...t, initialUserInput: t.initialUserInput ?? t.initialValue }), this.on("userInput", (s) => {
      this._setValue(s);
    }), this.on("finalize", () => {
      this.value || (this.value = t.defaultValue), this.value === undefined && (this.value = "");
    });
  }
}

// node_modules/@clack/prompts/dist/index.mjs
import { styleText as e, stripVTControlCharacters as nt2 } from "util";
import V2 from "process";
var import_sisteransi2 = __toESM(require_src(), 1);
function ee() {
  return V2.platform !== "win32" ? V2.env.TERM !== "linux" : !!V2.env.CI || !!V2.env.WT_SESSION || !!V2.env.TERMINUS_SUBLIME || V2.env.ConEmuTask === "{cmd::Cmder}" || V2.env.TERM_PROGRAM === "Terminus-Sublime" || V2.env.TERM_PROGRAM === "vscode" || V2.env.TERM === "xterm-256color" || V2.env.TERM === "alacritty" || V2.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var tt2 = ee();
var w2 = (t, i) => tt2 ? t : i;
var Tt = w2("\u25C6", "*");
var at2 = w2("\u25A0", "x");
var ut2 = w2("\u25B2", "x");
var H2 = w2("\u25C7", "o");
var lt = w2("\u250C", "T");
var $2 = w2("\u2502", "|");
var x2 = w2("\u2514", "\u2014");
var _t = w2("\u2510", "T");
var xt = w2("\u2518", "\u2014");
var z2 = w2("\u25CF", ">");
var U2 = w2("\u25CB", " ");
var et2 = w2("\u25FB", "[\u2022]");
var K2 = w2("\u25FC", "[+]");
var Y2 = w2("\u25FB", "[ ]");
var Et = w2("\u25AA", "\u2022");
var st2 = w2("\u2500", "-");
var ct = w2("\u256E", "+");
var Gt = w2("\u251C", "+");
var $t = w2("\u256F", "+");
var dt = w2("\u2570", "+");
var Mt = w2("\u256D", "+");
var ht2 = w2("\u25CF", "\u2022");
var pt = w2("\u25C6", "*");
var mt = w2("\u25B2", "!");
var gt = w2("\u25A0", "x");
var P2 = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return e("cyan", Tt);
    case "cancel":
      return e("red", at2);
    case "error":
      return e("yellow", ut2);
    case "submit":
      return e("green", H2);
  }
};
var yt = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return e("cyan", $2);
    case "cancel":
      return e("red", $2);
    case "error":
      return e("yellow", $2);
    case "submit":
      return e("green", $2);
  }
};
var Ot = (t, i, s, r, u, n = false) => {
  let a = i, c = 0;
  if (n)
    for (let o = r - 1;o >= s && (a -= t[o].length, c++, !(a <= u)); o--)
      ;
  else
    for (let o = s;o < r && (a -= t[o].length, c++, !(a <= u)); o++)
      ;
  return { lineCount: a, removals: c };
};
var F2 = ({ cursor: t, options: i, style: s, output: r = process.stdout, maxItems: u = Number.POSITIVE_INFINITY, columnPadding: n = 0, rowPadding: a = 4 }) => {
  const c = A(r) - n, o = L(r), l = e("dim", "..."), d = Math.max(o - a, 0), g = Math.max(Math.min(u, d), 5);
  let p2 = 0;
  t >= g - 3 && (p2 = Math.max(Math.min(t - g + 3, i.length - g), 0));
  let f2 = g < i.length && p2 > 0, h2 = g < i.length && p2 + g < i.length;
  const I2 = Math.min(p2 + g, i.length), m2 = [];
  let y = 0;
  f2 && y++, h2 && y++;
  const v2 = p2 + (f2 ? 1 : 0), C2 = I2 - (h2 ? 1 : 0);
  for (let b = v2;b < C2; b++) {
    const G2 = wrapAnsi(s(i[b], b === t), c, { hard: true, trim: false }).split(`
`);
    m2.push(G2), y += G2.length;
  }
  if (y > d) {
    let b = 0, G2 = 0, M = y;
    const N2 = t - v2;
    let O = d;
    const j2 = () => Ot(m2, M, 0, N2, O), k2 = () => Ot(m2, M, N2 + 1, m2.length, O, true);
    f2 ? ({ lineCount: M, removals: b } = j2(), M > O && (h2 || (O -= 1), { lineCount: M, removals: G2 } = k2())) : (h2 || (O -= 1), { lineCount: M, removals: G2 } = k2(), M > O && (O -= 1, { lineCount: M, removals: b } = j2())), b > 0 && (f2 = true, m2.splice(0, b)), G2 > 0 && (h2 = true, m2.splice(m2.length - G2, G2));
  }
  const S2 = [];
  f2 && S2.push(l);
  for (const b of m2)
    for (const G2 of b)
      S2.push(G2);
  return h2 && S2.push(l), S2;
};
var R2 = { message: (t = [], { symbol: i = e("gray", $2), secondarySymbol: s = e("gray", $2), output: r = process.stdout, spacing: u = 1, withGuide: n } = {}) => {
  const a = [], c = n ?? h.withGuide, o = c ? s : "", l = c ? `${i}  ` : "", d = c ? `${s}  ` : "";
  for (let p2 = 0;p2 < u; p2++)
    a.push(o);
  const g = Array.isArray(t) ? t : t.split(`
`);
  if (g.length > 0) {
    const [p2, ...f2] = g;
    p2.length > 0 ? a.push(`${l}${p2}`) : a.push(c ? i : "");
    for (const h2 of f2)
      h2.length > 0 ? a.push(`${d}${h2}`) : a.push(c ? s : "");
  }
  r.write(`${a.join(`
`)}
`);
}, info: (t, i) => {
  R2.message(t, { ...i, symbol: e("blue", ht2) });
}, success: (t, i) => {
  R2.message(t, { ...i, symbol: e("green", pt) });
}, step: (t, i) => {
  R2.message(t, { ...i, symbol: e("green", H2) });
}, warn: (t, i) => {
  R2.message(t, { ...i, symbol: e("yellow", mt) });
}, warning: (t, i) => {
  R2.warn(t, i);
}, error: (t, i) => {
  R2.message(t, { ...i, symbol: e("red", gt) });
} };
var me = (t = "", i) => {
  const s = i?.output ?? process.stdout, r = i?.withGuide ?? h.withGuide ? `${e("gray", x2)}  ` : "";
  s.write(`${r}${e("red", t)}

`);
};
var ge = (t = "", i) => {
  const s = i?.output ?? process.stdout, r = i?.withGuide ?? h.withGuide ? `${e("gray", lt)}  ` : "";
  s.write(`${r}${t}
`);
};
var ye = (t = "", i) => {
  const s = i?.output ?? process.stdout, r = i?.withGuide ?? h.withGuide ? `${e("gray", $2)}
${e("gray", x2)}  ` : "";
  s.write(`${r}${t}

`);
};
var we = (t) => e("dim", t);
var be = (t, i, s) => {
  const r = { hard: true, trim: false }, u = wrapAnsi(t, i, r).split(`
`), n = u.reduce((o, l) => Math.max(dist_default2(l), o), 0), a = u.map(s).reduce((o, l) => Math.max(dist_default2(l), o), 0), c = i - (a - n);
  return wrapAnsi(t, c, r);
};
var Se = (t = "", i = "", s) => {
  const r = s?.output ?? V2.stdout, u = s?.withGuide ?? h.withGuide, n = s?.format ?? we, a = ["", ...be(t, A(r) - 6, n).split(`
`).map(n), ""], c = dist_default2(i), o = Math.max(a.reduce((p2, f2) => {
    const h2 = dist_default2(f2);
    return h2 > p2 ? h2 : p2;
  }, 0), c) + 2, l = a.map((p2) => `${e("gray", $2)}  ${p2}${" ".repeat(o - dist_default2(p2))}${e("gray", $2)}`).join(`
`), d = u ? `${e("gray", $2)}
` : "", g = u ? Gt : dt;
  r.write(`${d}${e("green", H2)}  ${e("reset", i)} ${e("gray", st2.repeat(Math.max(o - c - 1, 1)) + ct)}
${l}
${e("gray", g + st2.repeat(o + 2) + $t)}
`);
};
var jt = { light: w2("\u2500", "-"), heavy: w2("\u2501", "="), block: w2("\u2588", "#") };
var it2 = (t, i) => t.includes(`
`) ? t.split(`
`).map((s) => i(s)).join(`
`) : i(t);
var xe = (t) => {
  const i = (s, r) => {
    const u = s.label ?? String(s.value);
    switch (r) {
      case "disabled":
        return `${e("gray", U2)} ${it2(u, (n) => e("gray", n))}${s.hint ? ` ${e("dim", `(${s.hint ?? "disabled"})`)}` : ""}`;
      case "selected":
        return `${it2(u, (n) => e("dim", n))}`;
      case "active":
        return `${e("green", z2)} ${u}${s.hint ? ` ${e("dim", `(${s.hint})`)}` : ""}`;
      case "cancelled":
        return `${it2(u, (n) => e(["strikethrough", "dim"], n))}`;
      default:
        return `${e("dim", U2)} ${it2(u, (n) => e("dim", n))}`;
    }
  };
  return new ut({ options: t.options, signal: t.signal, input: t.input, output: t.output, initialValue: t.initialValue, render() {
    const s = t.withGuide ?? h.withGuide, r = `${P2(this.state)}  `, u = `${yt(this.state)}  `, n = W(t.output, t.message, u, r), a = `${s ? `${e("gray", $2)}
` : ""}${n}
`;
    switch (this.state) {
      case "submit": {
        const c = s ? `${e("gray", $2)}  ` : "", o = W(t.output, i(this.options[this.cursor], "selected"), c);
        return `${a}${o}`;
      }
      case "cancel": {
        const c = s ? `${e("gray", $2)}  ` : "", o = W(t.output, i(this.options[this.cursor], "cancelled"), c);
        return `${a}${o}${s ? `
${e("gray", $2)}` : ""}`;
      }
      default: {
        const c = s ? `${e("cyan", $2)}  ` : "", o = s ? e("cyan", x2) : "", l = a.split(`
`).length, d = s ? 2 : 1;
        return `${a}${c}${F2({ output: t.output, cursor: this.cursor, options: this.options, maxItems: t.maxItems, columnPadding: c.length, rowPadding: l + d, style: (g, p2) => i(g, g.disabled ? "disabled" : p2 ? "active" : "inactive") }).join(`
${c}`)}
${o}
`;
      }
    }
  } }).prompt();
};
var Nt = `${e("gray", $2)}  `;
var Pe = (t) => new ht({ validate: t.validate, placeholder: t.placeholder, defaultValue: t.defaultValue, initialValue: t.initialValue, output: t.output, signal: t.signal, input: t.input, render() {
  const i = t?.withGuide ?? h.withGuide, s = `${`${i ? `${e("gray", $2)}
` : ""}${P2(this.state)}  `}${t.message}
`, r = t.placeholder ? e("inverse", t.placeholder[0]) + e("dim", t.placeholder.slice(1)) : e(["inverse", "hidden"], "_"), u = this.userInput ? this.userInputWithCursor : r, n = this.value ?? "";
  switch (this.state) {
    case "error": {
      const a = this.error ? `  ${e("yellow", this.error)}` : "", c = i ? `${e("yellow", $2)}  ` : "", o = i ? e("yellow", x2) : "";
      return `${s.trim()}
${c}${u}
${o}${a}
`;
    }
    case "submit": {
      const a = n ? `  ${e("dim", n)}` : "", c = i ? e("gray", $2) : "";
      return `${s}${c}${a}`;
    }
    case "cancel": {
      const a = n ? `  ${e(["strikethrough", "dim"], n)}` : "", c = i ? e("gray", $2) : "";
      return `${s}${c}${a}${n.trim() ? `
${c}` : ""}`;
    }
    default: {
      const a = i ? `${e("cyan", $2)}  ` : "", c = i ? e("cyan", x2) : "";
      return `${s}${a}${u}
${c}
`;
    }
  }
} }).prompt();

// src/cli/setup.ts
import { existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";

// src/bridge/credentials.ts
import { readFile, chmod, mkdir, rename, open } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
function defaultCredentialsPath() {
  const raw = process.env.TEAMEM_CREDENTIALS;
  const looksLikePlaceholder = typeof raw === "string" && /^\$\{[^}]*\}$/.test(raw.trim());
  if (raw && !looksLikePlaceholder && raw.trim().length > 0) {
    return raw;
  }
  return join(homedir(), ".teamem", "credentials.json");
}
async function loadCredentials(credPath) {
  const path = credPath ?? defaultCredentialsPath();
  if (!existsSync(path))
    return null;
  let raw;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isCredentialsFile(parsed))
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function isCredentialsFile(v2) {
  if (typeof v2 !== "object" || v2 === null)
    return false;
  const obj = v2;
  if (obj.version !== 1)
    return false;
  if (typeof obj.spaces !== "object" || obj.spaces === null)
    return false;
  if ("bridge_dir" in obj && (typeof obj.bridge_dir !== "string" || obj.bridge_dir === ""))
    return false;
  return true;
}
async function saveCredentials(creds, credPath) {
  const path = credPath ?? defaultCredentialsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmpPath = `${path}.tmp`;
  const data = JSON.stringify(creds, null, 2);
  const handle = await open(tmpPath, "w", 384);
  try {
    await handle.writeFile(data, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
  await chmod(path, 384);
}
async function appendEntry(entry, credPath, options = {}) {
  let creds = await loadCredentials(credPath);
  if (!creds) {
    creds = { version: 1, default_space_id: null, spaces: {} };
  }
  creds.spaces[entry.space_id] = entry;
  if (options.makeDefault || !creds.default_space_id) {
    creds.default_space_id = entry.space_id;
  }
  await saveCredentials(creds, credPath);
}

// src/cli/identity-default.ts
var GENERIC_NAMES = new Set(["root", "ubuntu", "admin", "user", "nobody"]);
function suggestMemberNameDefault(probe) {
  const fromGit = probe.runGitConfigUserName();
  const gitFirst = fromGit ? firstWhitespaceToken(fromGit) : null;
  if (gitFirst && !isGeneric(gitFirst))
    return gitFirst;
  const fromEnv = probe.envUser();
  if (fromEnv && !isGeneric(fromEnv))
    return fromEnv;
  const fromWhoami = probe.runWhoami();
  if (fromWhoami && !isGeneric(fromWhoami))
    return fromWhoami;
  return null;
}
function isGeneric(name) {
  return GENERIC_NAMES.has(name.trim().toLowerCase());
}
function firstWhitespaceToken(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    return null;
  const m2 = trimmed.match(/^\S+/);
  return m2 ? m2[0] : null;
}
function realIdentityProbe() {
  return {
    runGitConfigUserName() {
      try {
        const { spawnSync } = __require("child_process");
        const r = spawnSync("git", ["config", "--global", "user.name"], {
          encoding: "utf-8",
          timeout: 1000
        });
        if (r.status !== 0)
          return null;
        const out = (r.stdout ?? "").trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    },
    runWhoami() {
      try {
        const { userInfo } = __require("os");
        const u = userInfo().username;
        return typeof u === "string" && u.length > 0 ? u : null;
      } catch {
        return null;
      }
    },
    envUser() {
      const v2 = process.env.USER ?? process.env.USERNAME ?? "";
      return v2.length > 0 ? v2 : null;
    }
  };
}

// src/cli/setup.ts
var AC24_WARNING = "(share via SECURE channel only \u2014 Signal/1Password/in-person)";
async function promptCoordPref() {
  Se("The current plugin build uses queue-first coordination. Negotiator automation is postponed, so setup keeps the default `auto-skip` preference.", "Coordination");
  return "auto-skip";
}
async function applyCoordPref(_baseUrl, _jwt, pref) {
  if (pref === "auto-skip")
    return;
}
async function resolveBridgeDir(credPath) {
  const creds = await loadCredentials(credPath);
  const fromCreds = creds?.bridge_dir;
  if (fromCreds && existsSync2(join2(fromCreds, "src", "bridge"))) {
    return fromCreds;
  }
  const fromEnv = process.env.TEAMEM_BRIDGE_DIR;
  if (fromEnv && existsSync2(join2(fromEnv, "src", "bridge"))) {
    return fromEnv;
  }
  return null;
}
async function runCheck() {
  const credPath = defaultCredentialsPath();
  let allPass = true;
  const creds = await loadCredentials(credPath);
  const credsExist = existsSync2(credPath);
  if (credsExist && creds !== null) {
    process.stdout.write(`[PASS] credentials_found
`);
  } else {
    process.stdout.write(`[FAIL] credentials_found
`);
    allPass = false;
  }
  const bridgeDir = await resolveBridgeDir(credPath);
  if (bridgeDir !== null) {
    process.stdout.write(`[PASS] bridge_dir_resolved
`);
  } else {
    process.stdout.write(`[FAIL] bridge_dir_unresolved
`);
    allPass = false;
  }
  const homeDir = homedir2();
  let provider = "unknown";
  if (existsSync2(join2(homeDir, ".claude", "settings.local.json"))) {
    provider = "claude";
  } else if (existsSync2(join2(homeDir, ".codex", "config.toml"))) {
    provider = "codex";
  }
  if (provider === "unknown") {
    process.stdout.write(`[WARN] hooks_provider_unknown (neither ~/.claude/settings.local.json nor ~/.codex/config.toml found)
`);
  } else if (bridgeDir !== null) {
    const hooksFile = join2(bridgeDir, "hooks", provider, "pre-tool-use.sh");
    if (existsSync2(hooksFile)) {
      process.stdout.write(`[PASS] hooks_installed (${provider})
`);
    } else {
      process.stdout.write(`[FAIL] hooks_missing (${provider}: ${hooksFile} not found)
`);
      allPass = false;
    }
  } else {
    process.stdout.write(`[FAIL] hooks_check_skipped (bridge_dir unresolved)
`);
    allPass = false;
  }
  process.exit(allPass ? 0 : 2);
}
function printRoomCode(code) {
  Se(`Your room code: ${code}
${AC24_WARNING}`, "Room code");
}
function bail(msg) {
  me(msg);
  process.exit(1);
}
function credentialsOutputPath(credPath) {
  return credPath ?? defaultCredentialsPath();
}
function parseNonInteractive() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  if (jsonIdx === -1)
    return null;
  const raw = args[jsonIdx + 1];
  if (!raw)
    return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function runNonInteractive(opts) {
  const baseUrl = opts.serverUrl.trim().replace(/\/$/, "");
  const memberName = opts.memberName.trim();
  if (opts.flow === "create") {
    const body = { member_name: memberName };
    if (opts.spaceLabel?.trim())
      body.label = opts.spaceLabel.trim();
    let res;
    try {
      res = await fetch(`${baseUrl}/spaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (err) {
      process.stderr.write(`Network error: ${err.message}
`);
      process.exit(1);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      process.stderr.write(`Server error ${res.status}: ${errBody.error ?? "unknown"}
`);
      process.exit(1);
    }
    const data = await res.json();
    const jwtParts = data.jwt.split(".");
    const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
    const entry = {
      space_id: data.space_id,
      label: data.label ?? opts.spaceLabel ?? data.space_id,
      member_name: memberName,
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };
    await appendEntry(entry, opts.credPath, { makeDefault: true });
    process.stdout.write(`Your room code: ${data.room_code}
${AC24_WARNING}
`);
    process.stdout.write(`Space created. Credentials saved to ${credentialsOutputPath(opts.credPath)}.
`);
  } else {
    const roomCode = opts.roomCode?.trim();
    if (!roomCode) {
      process.stderr.write(`room_code required for join flow
`);
      process.exit(1);
    }
    let res;
    try {
      res = await fetch(`${baseUrl}/spaces/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_code: roomCode,
          member_name: memberName
        })
      });
    } catch (err) {
      process.stderr.write(`Network error: ${err.message}
`);
      process.exit(1);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errCode = errBody.error;
      if (errCode === "invalid_code") {
        process.stderr.write(`Invalid room code. Check the code and try again.
`);
      } else if (errCode === "code_expired") {
        process.stderr.write(`Room code has expired. Ask your team to rotate it.
`);
      } else if (errCode === "name_taken") {
        process.stderr.write(`Name '${memberName}' is already taken in this space.
`);
      } else {
        process.stderr.write(`Server error ${res.status}: ${errCode ?? "unknown"}
`);
      }
      process.exit(1);
    }
    const data = await res.json();
    const jwtParts = data.jwt.split(".");
    const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
    const entry = {
      space_id: data.space_id,
      label: data.label ?? data.space_id,
      member_name: memberName,
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };
    await appendEntry(entry, opts.credPath, { makeDefault: true });
    process.stdout.write(`Joined space ${data.space_id}
`);
    process.stdout.write(`Credentials saved to ${credentialsOutputPath(opts.credPath)}.
`);
  }
}
async function runInteractive() {
  ge("teamem setup");
  const creds = await loadCredentials();
  if (creds && Object.keys(creds.spaces).length > 0) {
    const action = await xe({
      message: "Credentials already exist. What would you like to do?",
      options: [
        { value: "add", label: "Add another space" },
        { value: "abort", label: "Abort" }
      ]
    });
    if (q(action) || action === "abort") {
      bail("Setup aborted.");
    }
  }
  const serverUrl = await Pe({
    message: "Server URL",
    placeholder: "http://localhost:3000",
    defaultValue: "http://localhost:3000"
  });
  if (q(serverUrl))
    bail("Setup cancelled.");
  const baseUrl = serverUrl.replace(/\/$/, "");
  const flow = await xe({
    message: "What would you like to do?",
    options: [
      { value: "create", label: "Create a new space (you become the creator)" },
      { value: "join", label: "Join an existing space with a room code" }
    ]
  });
  if (q(flow))
    bail("Setup cancelled.");
  const suggestedMemberName = suggestMemberNameDefault(realIdentityProbe());
  if (flow === "create") {
    const memberName = await Pe({
      message: "Your name in this space",
      placeholder: suggestedMemberName ?? "alice",
      ...suggestedMemberName ? { initialValue: suggestedMemberName } : {}
    });
    if (q(memberName) || !memberName.trim())
      bail("Setup cancelled.");
    const spaceLabel = await Pe({
      message: "Space label (optional)",
      placeholder: "my-team"
    });
    if (q(spaceLabel))
      bail("Setup cancelled.");
    const body = {
      member_name: memberName.trim()
    };
    if (spaceLabel.trim())
      body.label = spaceLabel.trim();
    let res;
    try {
      res = await fetch(`${baseUrl}/spaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (err) {
      bail(`Network error: ${err.message}`);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      bail(`Server error ${res.status}: ${errBody.error ?? "unknown"}`);
    }
    const data = await res.json();
    const jwtParts = data.jwt.split(".");
    const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
    const entry = {
      space_id: data.space_id,
      label: data.label ?? body.label ?? data.space_id,
      member_name: memberName.trim(),
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };
    await appendEntry(entry, undefined, { makeDefault: true });
    const coordPref = await promptCoordPref();
    await applyCoordPref(baseUrl, data.jwt, coordPref);
    printRoomCode(data.room_code);
    ye(`Space created (coord pref: ${coordPref}). Credentials saved to ${credentialsOutputPath()}`);
  } else {
    const roomCode = await Pe({
      message: "Room code",
      placeholder: "ABCD1234"
    });
    if (q(roomCode) || !roomCode.trim())
      bail("Setup cancelled.");
    const memberName = await Pe({
      message: "Your name in this space",
      placeholder: suggestedMemberName ?? "alice",
      ...suggestedMemberName ? { initialValue: suggestedMemberName } : {}
    });
    if (q(memberName) || !memberName.trim())
      bail("Setup cancelled.");
    let res;
    try {
      res = await fetch(`${baseUrl}/spaces/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_code: roomCode.trim(),
          member_name: memberName.trim()
        })
      });
    } catch (err) {
      bail(`Network error: ${err.message}`);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errCode = errBody.error;
      if (errCode === "invalid_code")
        bail("Invalid room code. Check the code and try again.");
      if (errCode === "code_expired")
        bail("Room code has expired. Ask your team to rotate it.");
      if (errCode === "name_taken")
        bail(`Name '${memberName.trim()}' is already taken in this space.`);
      bail(`Server error ${res.status}: ${errCode ?? "unknown"}`);
    }
    const data = await res.json();
    const jwtParts = data.jwt.split(".");
    const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
    const entry = {
      space_id: data.space_id,
      label: data.label ?? data.space_id,
      member_name: memberName.trim(),
      jwt: data.jwt,
      jwt_exp: payload.exp,
      server_url: baseUrl
    };
    await appendEntry(entry, undefined, { makeDefault: true });
    R2.success(`Joined space ${data.space_id}`);
    const coordPref = await promptCoordPref();
    await applyCoordPref(baseUrl, data.jwt, coordPref);
    ye(`Credentials saved to ${credentialsOutputPath()} (coord pref: ${coordPref})`);
  }
}
async function main() {
  if (process.argv.includes("--check")) {
    await runCheck();
    return;
  }
  const nonInteractive = parseNonInteractive();
  if (nonInteractive) {
    await runNonInteractive(nonInteractive);
  } else {
    await runInteractive();
  }
}
main().catch((err) => {
  process.stderr.write(`setup fatal: ${err.message}
`);
  process.exit(1);
});
export {
  printRoomCode
};
