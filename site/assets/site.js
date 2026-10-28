/* Shared download links, screenshot lightbox, guide navigation, mobile menu and
 * the changelog. Start each feature only when its markup exists.
 * Release notes come from the product's published GitHub Releases: each body is
 * the reviewed CHANGELOG.md entry for that tag, in the changelog grammar
 * (headline, summary, New/Improved/Fixed groups, collapsed line). */

(function () {
  "use strict";

  var REPO = "doom-snapmap/snapmap-plus";
  var API = "https://api.github.com/repos/" + REPO + "/releases";

  /* ---------- 1. download resolver ---------- */

  function resolveDownload() {
    var links = document.querySelectorAll("[data-dl]");
    if (!links.length) return;
    fetchReleases().then(function (rels) {
      if (!rels || !rels.length) return;
      var pick = null;
      for (var i = 0; i < rels.length; i++) {
        if (!rels[i].draft && !rels[i].prerelease) { pick = rels[i]; break; }
      }
      if (!pick) {
        for (var j = 0; j < rels.length; j++) {
          if (!rels[j].draft) { pick = rels[j]; break; }
        }
      }
      if (!pick) return;
      var asset = null;
      for (var k = 0; k < pick.assets.length; k++) {
        if (pick.assets[k].name === "snapmap-plus.exe") { asset = pick.assets[k]; break; }
      }
      if (!asset) return;
      links.forEach(function (a) { a.href = asset.browser_download_url; });
      var ver = document.getElementById("dl-version");
      if (ver) ver.textContent = pick.tag_name;
      var pill = document.getElementById("beta-pill");
      if (pill && pick.prerelease) pill.style.display = "inline-block";
    });
  }

  var releasesPromise = null;
  function fetchReleases() {
    if (!releasesPromise) {
      releasesPromise = fetch(API)
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return releasesPromise;
  }

  /* ---------- 2. lightbox ---------- */

  function initLightbox() {
    var images = Array.prototype.slice.call(
      document.querySelectorAll(".shot img, .guide-doc img")
    );
    if (!images.length || typeof HTMLDialogElement === "undefined") return;

    var dialog = document.createElement("dialog");
    dialog.className = "lightbox";
    dialog.setAttribute("aria-label", "Image viewer");
    dialog.innerHTML =
      '<figure><img alt=""><figcaption></figcaption></figure>' +
      '<button class="lightbox-close" type="button" aria-label="Close image viewer">&#10005;</button>';
    document.body.appendChild(dialog);

    var img = dialog.querySelector("img");
    var cap = dialog.querySelector("figcaption");
    var current = -1;

    function captionFor(el) {
      var fig = el.closest("figure");
      var fc = fig && fig.querySelector("figcaption");
      if (fc) return fc.textContent;
      return el.getAttribute("alt") || "";
    }

    function show(i) {
      current = (i + images.length) % images.length;
      var src = images[current];
      img.src = src.currentSrc || src.src;
      img.alt = src.getAttribute("alt") || "";
      cap.textContent = captionFor(src);
    }

    images.forEach(function (el, i) {
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", "Expand image: " + (el.getAttribute("alt") || "screenshot"));
      function open() { show(i); dialog.showModal(); }
      el.addEventListener("click", open);
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
    });

    dialog.querySelector(".lightbox-close").addEventListener("click", function () {
      dialog.close();
    });
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) dialog.close(); // backdrop click
    });
    dialog.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") show(current + 1);
      if (e.key === "ArrowLeft") show(current - 1);
    });
  }

  /* ---------- 3. guide TOC ---------- */

  function initToc() {
    var toc = document.getElementById("guide-toc-list");
    var doc = document.querySelector(".guide-doc");
    if (!toc || !doc) return;
    var heads = Array.prototype.slice.call(doc.querySelectorAll("h2[id], h3[id]"));
    if (heads.length < 2) {
      var aside = toc.closest(".guide-toc");
      if (aside) aside.style.display = "none";
      return;
    }
    /* collapsed by default on small screens (it renders as a block above the doc there) */
    var details = document.getElementById("guide-toc-details");
    if (details && window.matchMedia("(max-width: 960px)").matches) {
      details.removeAttribute("open");
    }

    var links = {};
    heads.forEach(function (h) {
      var li = document.createElement("li");
      li.className = "toc-" + h.tagName.toLowerCase();
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      toc.appendChild(li);
      links[h.id] = a;
    });

    if ("IntersectionObserver" in window) {
      var activeId = null;
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            if (activeId && links[activeId]) links[activeId].classList.remove("active");
            activeId = entry.target.id;
            if (links[activeId]) links[activeId].classList.add("active");
          }
        });
      }, { rootMargin: "-80px 0px -70% 0px" });
      heads.forEach(function (h) { observer.observe(h); });
    }
  }

  /* ---------- 4. mobile nav ---------- */

  function initNav() {
    var header = document.querySelector(".site-header");
    if (!header) return;
    var toggle = header.querySelector(".nav-toggle");
    var menu = header.querySelector(".nav-menu");
    if (!toggle || !menu) return;

    function setOpen(open) {
      header.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    toggle.addEventListener("click", function () {
      setOpen(!header.classList.contains("nav-open"));
    });

    // a tap on any menu link dismisses the panel
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    // Escape closes and returns focus to the toggle
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && header.classList.contains("nav-open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    // a tap outside the header closes the panel
    document.addEventListener("click", function (e) {
      if (header.classList.contains("nav-open") && !header.contains(e.target)) {
        setOpen(false);
      }
    });

    // widening back to the desktop layout resets state
    var mq = window.matchMedia("(min-width: 761px)");
    var onChange = function (e) { if (e.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---------- 5. changelog ---------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Inline Markdown as the changelog grammar allows it: code spans, bold,
   * italics and links. Everything is escaped first. */
  function inline(md) {
    var codes = [];
    var s = esc(md).replace(/`([^`]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return "<code>" + codes[i] + "</code>"; });
  }

  /* The same grammar tools/changelog.py parses in snapmap-plus. */
  function parseNotes(body) {
    var out = { headline: "", summary: "", added: [], improved: [], fixed: [], collapsed: "" };
    var groups = { New: "added", Improved: "improved", Fixed: "fixed" };
    var group = null;
    var summary = [];
    String(body || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (!line.trim()) return;
      var m = /^### +(New|Improved|Fixed)\s*$/.exec(line);
      if (m) { group = groups[m[1]]; return; }
      m = /^- +(.*\S)\s*$/.exec(line);
      if (m && group) { out[group].push(m[1]); return; }
      if (group && out[group].length && /^[ \t]/.test(raw)) {
        out[group][out[group].length - 1] += " " + line.trim();
        return;
      }
      m = /^\*\*(.+?)\*\*\s*$/.exec(line);
      if (m && !out.headline) { out.headline = m[1]; return; }
      m = /^_(.+?)_\s*$/.exec(line);
      if (m) { out.collapsed = m[1]; return; }
      if (group === null) summary.push(line.trim());
    });
    out.summary = summary.join(" ");
    return out;
  }

  function longDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  var COPY_BUTTON =
    '<button class="release-copy" type="button" aria-label="Copy changelog" title="Copy changelog" hidden>' +
    /* Lucide copy and check icons; license: assets/lucide-license.txt */
    '<svg class="copy-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
    '<svg class="check-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>' +
    '</button>';

  function releaseHtml(rel, isLatest) {
    var notes = parseNotes(rel.body);
    var h = '<article class="release"><div class="release-head">';
    h += "<h2>" + esc(rel.tag_name) + "</h2>";
    h += '<time datetime="' + esc(rel.published_at || "") + '">' + esc(longDate(rel.published_at)) + "</time>";
    if (rel.prerelease) h += '<span class="tag-pill tag-beta">Beta</span>';
    if (isLatest) h += '<span class="tag-pill tag-latest">Latest</span>';
    h += '</div><div class="release-notes">';
    if (notes.headline) h += "<p><strong>" + inline(notes.headline) + "</strong></p>";
    if (notes.summary) h += "<p>" + inline(notes.summary) + "</p>";
    [["added", "New"], ["improved", "Improved"], ["fixed", "Fixed"]].forEach(function (g) {
      var items = notes[g[0]];
      if (!items.length) return;
      h += "<p><strong>" + g[1] + "</strong></p><ul>";
      items.forEach(function (item) { h += "<li>" + inline(item) + "</li>"; });
      h += "</ul>";
    });
    if (!notes.headline && !notes.summary && !notes.added.length && !notes.improved.length && !notes.fixed.length) {
      /* a body outside the grammar still shows, as plain paragraphs */
      String(rel.body || "").split(/\r?\n\s*\r?\n/).forEach(function (para) {
        if (para.trim()) h += "<p>" + inline(para.trim()) + "</p>";
      });
    }
    if (notes.collapsed) h += "<p><em>" + inline(notes.collapsed) + "</em></p>";
    h += "</div>";
    h += '<pre class="release-markdown" hidden>' + esc(String(rel.body || "").trim()) + "</pre>";
    h += '<div class="release-links"><a href="' + esc(rel.html_url) + '">View on GitHub</a>' + COPY_BUTTON +
      '<span class="release-copy-status" role="status"></span></div>';
    return h + "</article>";
  }

  function initChangelog() {
    var host = document.querySelector("[data-releases]");
    if (!host) return;
    var releasesUrl = "https://github.com/" + REPO + "/releases";
    fetchReleases().then(function (rels) {
      if (!rels) {
        host.innerHTML = '<div class="changelog-fallback">Couldn\u2019t load the release list. See ' +
          '<a href="' + releasesUrl + '">GitHub releases</a>.</div>';
        return;
      }
      var shown = rels.filter(function (r) { return !r.draft; });
      if (!shown.length) {
        host.innerHTML = '<div class="changelog-fallback">No releases yet. Watch ' +
          '<a href="' + releasesUrl + '">GitHub releases</a> for the first one.</div>';
        return;
      }
      var latest = null;
      for (var i = 0; i < shown.length; i++) {
        if (!shown[i].prerelease) { latest = shown[i].tag_name; break; }
      }
      host.innerHTML = shown.map(function (r) { return releaseHtml(r, r.tag_name === latest); }).join("");
      initChangelogCopy();
    });
  }

  /* ---------- 6. changelog copy ---------- */

  function releaseAnnouncement(release) {
    var parts = [
      "## Snapmap+ " + release.querySelector("h2").textContent.trim(),
      release.querySelector("time").textContent.trim()
    ];
    // Copy the source so inline bold/code retain their exact Markdown boundaries.
    var notes = release.querySelector(".release-markdown").textContent.trim();
    if (notes) parts.push(notes);
    parts.push("[View on GitHub](" + release.querySelector(".release-links a").href + ")");
    return parts.join("\n\n");
  }

  function initChangelogCopy() {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    document.querySelectorAll(".release-copy").forEach(function (button) {
      var release = button.closest(".release");
      var status = release.querySelector(".release-copy-status");
      var label = "Copy changelog for " + release.querySelector("h2").textContent.trim();
      var resetTimer;
      var copying = false;
      button.hidden = false;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", async function () {
        if (copying) return;
        copying = true;
        clearTimeout(resetTimer);
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", label);
        button.title = "Copy changelog";
        status.textContent = "";
        try {
          await navigator.clipboard.writeText(releaseAnnouncement(release));
          button.classList.add("is-copied");
          button.setAttribute("aria-label", "Changelog copied");
          button.title = "Copied!";
          status.textContent = "Copied!";
        } catch (error) {
          status.textContent = "Couldn't copy. Try again or select the notes to copy manually.";
        } finally {
          copying = false;
          resetTimer = setTimeout(function () {
            button.classList.remove("is-copied");
            button.setAttribute("aria-label", label);
            button.title = "Copy changelog";
            status.textContent = "";
          }, 3000);
        }
      });
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    resolveDownload();
    initLightbox();
    initToc();
    initNav();
    initChangelog();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
