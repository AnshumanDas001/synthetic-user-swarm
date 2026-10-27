// Browser-side helpers, installed on every page via addInitScript as window.__sus.
// Plain JS on purpose: it runs inside the page under test, not in Node.
(() => {
  if (window.__sus) return;

  // ---------------------------------------------------------------- live counters
  const state = { mutations: 0, cls: 0, lcp: 0, shifts: [] };
  const startObservers = () => {
    try {
      new MutationObserver((list) => {
        for (const m of list) {
          // Ignore our own overlay.
          if (m.target && m.target.id === "__sus_overlay") continue;
          if (m.target && m.target.closest && m.target.closest("#__sus_overlay")) continue;
          state.mutations++;
        }
      }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
  };
  if (document.documentElement) startObservers();
  else document.addEventListener("DOMContentLoaded", startObservers);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) {
          state.cls += e.value;
          state.shifts.push({ t: e.startTime, v: e.value });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) state.lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {}

  // ---------------------------------------------------------------- helpers
  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "label[for]",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=switch]", "[role=option]", "[role=combobox]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
    "[contenteditable=true]",
  ].join(",");

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };

  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "label") return "label";
    return "generic";
  };

  // Approximation of the accessible-name computation; good enough to spot unlabeled controls.
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(" ").trim();
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && text(l)) return text(l);
    }
    const wrap = el.closest("label");
    if (wrap && wrap !== el && text(wrap)) return text(wrap);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase()) && el.value) return el.value;
    if (tag === "img" && el.alt) return el.alt;
    const img = el.querySelector && el.querySelector("img[alt]");
    const t = tag === "input" || tag === "select" || tag === "textarea" ? "" : text(el);
    if (t) return t.slice(0, 80);
    if (img && img.alt) return img.alt;
    if (el.title) return el.title;
    if (el.placeholder) return el.placeholder;
    const svgTitle = el.querySelector && el.querySelector("svg title");
    if (svgTitle && svgTitle.textContent) return svgTitle.textContent.trim();
    return "";
  };

  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const testId = node.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId}"]`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) {
        parts[0] = `#${CSS.escape(node.id)}`;
        break;
      }
      node = parent;
    }
    return parts.join(" > ");
  };

  const isCovered = (el, r) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
    const top = document.elementFromPoint(cx, cy);
    return !!top && top !== el && !el.contains(top) && !top.contains(el) && !(top.closest && top.closest("label") && top.closest("label").control === el);
  };

  const stateOf = (el) => {
    const s = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    if (el.checked) s.push("checked");
    if (el.getAttribute("aria-expanded")) s.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-invalid") === "true" || (el.validity && !el.validity.valid && el.dataset.susTouched)) s.push("invalid");
    if (el.required) s.push("required");
    if (document.activeElement === el) s.push("focused");
    const tag = el.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && el.value && el.type !== "password") s.push(`value="${String(el.value).slice(0, 30)}"`);
    if (tag === "input" && el.type === "password" && el.value) s.push("value=[hidden]");
    if (tag === "select" && el.selectedOptions && el.selectedOptions[0]) s.push(`selected="${text(el.selectedOptions[0]).slice(0, 30)}"`);
    return s;
  };

  const pageFlags = () => {
    const validation = [];
    document.querySelectorAll("[role=alert],[aria-live],.error,.errors,.invalid-feedback,[aria-invalid=true]").forEach((e) => {
      if (visible(e) && text(e)) validation.push(text(e).slice(0, 160));
    });
    document.querySelectorAll("input,select,textarea").forEach((e) => {
      if (e.dataset.susTouched && e.validationMessage) validation.push(`${accessibleName(e) || e.name}: ${e.validationMessage}`);
    });
    const dialog = Array.from(document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")).some(visible);
    const bodyText = text(document.body || document.documentElement);
    const searchZero = /\b(no results|0 results|nothing found|no products found|no matches)\b/i.test(bodyText);
    return { validation: Array.from(new Set(validation)).slice(0, 10), dialog, searchZero, bodyText };
  };

  const focusInfo = () => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return { mark: null, selector: null };
    return { mark: a.getAttribute("data-sus-mark"), selector: cssPath(a) + "|" + (accessibleName(a) || "").slice(0, 30) };
  };

  // ---------------------------------------------------------------- public API
  window.__sus = {
    resetCounters() {
      state.mutations = 0;
    },
    counters() {
      // lateCls: shifts more than 1 s after navigation start — late-loading content moving the page under a person.
      const lateCls = state.shifts.filter((s) => s.t > 1000).reduce((a, s) => a + s.v, 0);
      return { mutations: state.mutations, cls: state.cls, lcp: state.lcp, lateCls };
    },

    // Page flags without re-assigning marks (marks from the last collect() stay valid).
    inspect() {
      const f = pageFlags();
      const fo = focusInfo();
      return { dialogOpen: f.dialog, validation: f.validation, searchZeroResults: f.searchZero, focused: fo.mark, focusedSelector: fo.selector };
    },

    // Assign Set-of-Marks numbers to every interactive element and describe them.
    collect(opts) {
      opts = opts || {};
      document.querySelectorAll("[data-sus-mark]").forEach((e) => e.removeAttribute("data-sus-mark"));
      const els = Array.from(document.querySelectorAll(INTERACTIVE)).filter(visible);
      // Collapse a label and the control it labels into one entry (the control).
      const filtered = els.filter((el) => !(el.tagName === "LABEL" && el.control && els.includes(el.control)));
      const elements = [];
      let mark = 1;
      for (const el of filtered) {
        if (elements.length >= (opts.max || 150)) break;
        const r = el.getBoundingClientRect();
        el.setAttribute("data-sus-mark", String(mark));
        elements.push({
          mark,
          role: roleOf(el),
          name: accessibleName(el),
          tag: el.tagName.toLowerCase(),
          state: stateOf(el),
          inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
          selector: cssPath(el),
          box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) },
          vbox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), vw: innerWidth, vh: innerHeight },
          covered: isCovered(el, r),
        });
        mark++;
      }

      // Text digest: headings and text blocks in reading order. Skimmers see ~12 words per block.
      const blocks = [];
      let wordsSeen = 0;
      const blockEls = document.querySelectorAll("h1,h2,h3,h4,p,li,td,th,label,legend,[role=alert],[role=status],dt,dd,figcaption,small,.price,span.badge");
      for (const b of blockEls) {
        if (!visible(b) || b.closest("#__sus_overlay")) continue;
        const r = b.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue; // only what is on screen
        let t = text(b);
        if (!t || blocks.some((x) => x.text === t)) continue;
        const isHeading = /^H[1-4]$/.test(b.tagName);
        const words = t.split(" ");
        if (opts.skim && !isHeading && words.length > (opts.skimWords || 12)) t = words.slice(0, opts.skimWords || 12).join(" ") + " …";
        wordsSeen += Math.min(words.length, opts.skim && !isHeading ? opts.skimWords || 12 : words.length);
        blocks.push({ tag: b.tagName.toLowerCase(), text: t.slice(0, 300) });
        if (blocks.length > 60) break;
      }

      const { validation, dialog, searchZero, bodyText } = pageFlags();
      return {
        url: location.href,
        title: document.title,
        elements,
        blocks,
        wordsSeen,
        validation,
        dialogOpen: dialog,
        searchZeroResults: searchZero,
        scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight), vh: innerHeight, vw: innerWidth },
        focused: focusInfo().mark,
        textHash: bodyText.length + ":" + bodyText.slice(0, 2000).split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7),
      };
    },

    // Numbered boxes over every marked element (Set-of-Marks overlay for the screenshot).
    drawMarks() {
      this.clearMarks();
      const overlay = document.createElement("div");
      overlay.id = "__sus_overlay";
      overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      const colors = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#9a6324", "#800000"];
      document.querySelectorAll("[data-sus-mark]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        const n = el.getAttribute("data-sus-mark");
        const c = colors[Number(n) % colors.length];
        const box = document.createElement("div");
        box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid ${c};box-sizing:border-box;`;
        const tag = document.createElement("div");
        tag.textContent = n;
        tag.style.cssText = `position:absolute;left:-2px;top:-16px;background:${c};color:#fff;font:bold 11px/14px monospace;padding:0 3px;`;
        if (r.top < 16) tag.style.top = "0px";
        box.appendChild(tag);
        overlay.appendChild(box);
      });
      document.documentElement.appendChild(overlay);
    },
    clearMarks() {
      const o = document.getElementById("__sus_overlay");
      if (o) o.remove();
    },

    elementState(mark) {
      const el = document.querySelector(`[data-sus-mark="${mark}"]`);
      if (!el) return null;
      // For form fields the meaningful "text" is the value the user typed.
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      return { text: (field ? String(el.value ?? "") : text(el)).slice(0, 500), html: el.outerHTML.slice(0, 2000), value: el.value ?? null };
    },

    markTouched(mark) {
      const el = document.querySelector(`[data-sus-mark="${mark}"]`);
      if (el) el.dataset.susTouched = "1";
    },

    pointHits(mark) {
      const el = document.querySelector(`[data-sus-mark="${mark}"]`);
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      return {
        found: true,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        covered: isCovered(el, r),
        coveredBy: (() => {
          const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return t && !el.contains(t) ? (t.id ? "#" + t.id : t.className ? "." + String(t.className).split(" ")[0] : t.tagName.toLowerCase()) : null;
        })(),
      };
    },

    // Colour-vision simulation (perception filter). Matrices from Machado et al. 2009, severity 1.0.
    setVision(kind) {
      const M = {
        protanopia: "0.152 1.053 -0.205 0 0  0.115 0.786 0.099 0 0  -0.004 -0.048 1.052 0 0  0 0 0 1 0",
        deuteranopia: "0.367 0.861 -0.228 0 0  0.280 0.673 0.047 0 0  -0.012 0.043 0.969 0 0  0 0 0 1 0",
        tritanopia: "1.256 -0.077 -0.179 0 0  -0.078 0.931 0.148 0 0  0.005 0.691 0.304 0 0  0 0 0 1 0",
        achromatopsia: "0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0",
      };
      let svg = document.getElementById("__sus_vision");
      if (!kind || kind === "normal") {
        if (svg) svg.remove();
        document.documentElement.style.filter = "";
        return;
      }
      if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.id = "__sus_vision";
        svg.setAttribute("style", "position:absolute;width:0;height:0");
        document.documentElement.appendChild(svg);
      }
      svg.innerHTML = `<filter id="__sus_cvd"><feColorMatrix type="matrix" values="${M[kind]}"/></filter>`;
      document.documentElement.style.filter = "url(#__sus_cvd)";
    },

    // Skim filter for the screenshot: body copy is blurred, headings and controls stay sharp.
    // The text digest still carries the first ~12 words of each block.
    setSkim(on) {
      let st = document.getElementById("__sus_skim");
      if (!on) {
        if (st) st.remove();
        return;
      }
      if (!st) {
        st = document.createElement("style");
        st.id = "__sus_skim";
        st.textContent = "p, li, dd, small { filter: blur(2.2px); }";
        document.head.appendChild(st);
      }
    },
  };
})();
