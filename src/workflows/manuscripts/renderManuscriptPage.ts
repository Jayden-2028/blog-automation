// manifest.json -> 열람용 index.html (날짜 -> 주제 -> 채널 3개 트리). file://로 여는 정적 페이지라
// 서버·번들러가 없다 - scripts/statusDashboard.ts와 같은 관례(문자열 템플릿 -> writeFile)를 따른다.
//
// 원고 본문은 Node에서 미리 parseManuscriptBlocks로 텍스트/이미지 블록으로 나눠 JSON에 담는다.
// 브라우저 쪽 JS가 같은 정규식을 다시 구현하면 화면에 보이는 것과 "복사" 버튼이 복사하는 것이
// 어긋날 위험이 있어, 파싱은 한 곳(parseManuscriptBlocks)에서만 한다.
//
// 수정(편집) 결과는 브라우저 localStorage에만 남는다(2026-09-05 사용자 결정) - 로컬 원고 파일은
// 항상 원본 그대로다. 정적 파일이라 서버에 다시 쓸 방법이 없다 - 나중에 그게 필요해지면 작은 로컬
// 서버가 있어야 한다(이번 범위 밖).

import { parseManuscriptBlocks } from "./parseManuscriptBlocks.js";
import type { ManuscriptBlock } from "./parseManuscriptBlocks.js";
import type { ManuscriptChannel } from "../../config/pipelinePaths.js";
import type { ManuscriptManifest, ManuscriptTopicEntry } from "./manuscriptManifest.js";

const CHANNEL_LABEL: Record<ManuscriptChannel, string> = {
  naver: "🟢 네이버",
  tistory: "🟠 티스토리",
  blogspot: "🔵 Blogspot",
};

type PageChannel = {
  channel: ManuscriptChannel;
  title: string;
  searchDescription: string | null;
  slug: string | null;
  tags: string[];
  blocks: ManuscriptBlock[];
};

type PageTopic = {
  jobId: string;
  keyword: string;
  category: string | null;
  date: string;
  channels: PageChannel[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** <script type="application/json"> 안에 JSON을 안전하게 넣는다 - "</script" 시퀀스만 깨뜨린다. */
function safeJson(data: unknown): string {
  return JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
}

function toPageTopic(entry: ManuscriptTopicEntry): PageTopic {
  return {
    jobId: entry.jobId,
    keyword: entry.keyword,
    category: entry.category,
    date: entry.date,
    channels: entry.channels.map((c) => ({
      channel: c.channel,
      title: c.title,
      searchDescription: c.searchDescription,
      slug: c.slug,
      tags: c.tags,
      blocks: parseManuscriptBlocks(c.body, c.imagePrompts),
    })),
  };
}

export function renderManuscriptPage(manifest: ManuscriptManifest, generatedAt: Date = new Date()): string {
  const topics = [...manifest.topics].sort((a, b) => b.date.localeCompare(a.date) || b.readyAt.localeCompare(a.readyAt));
  const pageTopics = topics.map(toPageTopic);

  const days = new Map<string, PageTopic[]>();
  for (const topic of pageTopics) {
    const list = days.get(topic.date) ?? [];
    list.push(topic);
    days.set(topic.date, list);
  }

  const generated = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  }).format(generatedAt);

  const treeHtml =
    days.size === 0
      ? `<div class="empty">아직 준비된 원고가 없습니다.</div>`
      : [...days.entries()]
          .map(
            ([date, topicsOfDay]) => `
      <details class="day" open>
        <summary>${escapeHtml(date)} <span class="count">${topicsOfDay.length}</span></summary>
        ${topicsOfDay
          .map(
            (topic) => `
        <details class="topic" data-job-id="${escapeHtml(topic.jobId)}" open>
          <summary>${escapeHtml(topic.keyword)}</summary>
          <ul class="channels">
            ${topic.channels
              .map(
                (c) =>
                  `<li><button type="button" class="channel-btn" data-job-id="${escapeHtml(topic.jobId)}" data-channel="${c.channel}">${CHANNEL_LABEL[c.channel]}</button></li>`
              )
              .join("\n            ")}
          </ul>
        </details>`
          )
          .join("\n")}
      </details>`
          )
          .join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>채널별 원고</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --card:#f6f8fa; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --card:#161b22; --accent:#60a5fa; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); display:flex; height:100vh;
         font:14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif; }
  aside { width:280px; flex:0 0 280px; border-right:1px solid var(--line); overflow-y:auto; padding:14px; }
  aside h1 { font-size:15px; margin:0 0 4px; }
  aside .meta { color:var(--muted); font-size:12px; margin-bottom:14px; }
  .empty { color:var(--muted); }
  details.day { margin-bottom:6px; }
  details.day > summary { font-weight:700; cursor:pointer; padding:4px 0; }
  details.day .count { color:var(--muted); font-weight:400; font-size:12px; }
  details.topic { margin:2px 0 2px 12px; }
  details.topic > summary { cursor:pointer; padding:4px 0; font-size:13px; }
  ul.channels { list-style:none; margin:0 0 6px 14px; padding:0; }
  .channel-btn { display:block; width:100%; text-align:left; background:none; border:none; color:var(--fg);
                 padding:5px 8px; border-radius:6px; cursor:pointer; font-size:13px; }
  .channel-btn:hover { background:var(--card); }
  .channel-btn.active { background:var(--accent); color:#fff; }
  main { flex:1; overflow-y:auto; padding:24px 32px; }
  .placeholder { color:var(--muted); }
  .doc-title { font-size:20px; font-weight:700; margin:0 0 12px; }
  .meta-grid { display:grid; grid-template-columns:120px 1fr auto; gap:6px 10px; align-items:start;
               background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:18px; }
  .meta-grid .k { color:var(--muted); font-size:12.5px; padding-top:3px; }
  .meta-grid .v { font-size:13.5px; word-break:break-word; }
  .mini-copy { border:1px solid var(--line); background:var(--bg); color:var(--fg); border-radius:5px;
               padding:2px 8px; font-size:12px; cursor:pointer; }
  .mini-copy:hover { border-color:var(--accent); }
  .toolbar { display:flex; gap:8px; margin-bottom:14px; }
  .btn { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:7px;
         padding:7px 14px; font-size:13px; cursor:pointer; }
  .btn:hover { border-color:var(--accent); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.active { background:#b45309; border-color:#b45309; color:#fff; }
  .edited-badge { font-size:12px; color:#b45309; margin-left:4px; }
  .body-block { margin-bottom:14px; }
  .text-block { white-space:pre-wrap; }
  .text-block[contenteditable="true"] { outline:2px dashed var(--accent); outline-offset:4px; padding:4px; border-radius:6px; }
  .image-card { border:1px dashed var(--line); border-radius:8px; padding:10px 12px; background:var(--card); }
  .image-card .label { font-size:12px; color:var(--muted); margin-bottom:4px; }
  .image-card .desc { font-size:13px; margin-bottom:8px; }
  .image-card .prompt { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px;
                         background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:8px 10px; white-space:pre-wrap; }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#1f2328; color:#fff;
           padding:8px 16px; border-radius:8px; font-size:13px; opacity:0; pointer-events:none; transition:opacity .15s; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
  <aside>
    <h1>채널별 원고</h1>
    <div class="meta">생성 ${escapeHtml(generated)} (KST)</div>
    ${treeHtml}
  </aside>
  <main id="main">
    <div class="placeholder">왼쪽에서 주제 → 채널을 선택하세요.</div>
  </main>
  <div class="toast" id="toast"></div>

  <script id="manuscript-data" type="application/json">${safeJson(pageTopics)}</script>
  <script>
    var DATA = JSON.parse(document.getElementById("manuscript-data").textContent);
    var CHANNEL_LABEL = ${safeJson(CHANNEL_LABEL)};
    var main = document.getElementById("main");
    var toastEl = document.getElementById("toast");
    var current = null; // { jobId, channel }

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      setTimeout(function () { toastEl.classList.remove("show"); }, 1400);
    }

    function copyText(text) {
      navigator.clipboard.writeText(text).then(
        function () { toast("복사했습니다"); },
        function () { toast("복사 실패 - 브라우저 권한을 확인하세요"); }
      );
    }

    function findTopicChannel(jobId, channel) {
      var topic = DATA.find(function (t) { return t.jobId === jobId; });
      if (!topic) return null;
      var ch = topic.channels.find(function (c) { return c.channel === channel; });
      if (!ch) return null;
      return { topic: topic, channel: ch };
    }

    function editStorageKey(jobId, channel) {
      return "manuscript-edit:" + jobId + ":" + channel;
    }

    function loadEdits(jobId, channel) {
      try {
        var raw = localStorage.getItem(editStorageKey(jobId, channel));
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function saveEdits(jobId, channel, texts) {
      try { localStorage.setItem(editStorageKey(jobId, channel), JSON.stringify(texts)); } catch (e) {}
    }

    function clearEdits(jobId, channel) {
      try { localStorage.removeItem(editStorageKey(jobId, channel)); } catch (e) {}
    }

    function escapeHtmlJs(value) {
      return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function renderChannel(jobId, channel) {
      var found = findTopicChannel(jobId, channel);
      if (!found) return;
      current = { jobId: jobId, channel: channel };

      document.querySelectorAll(".channel-btn").forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.jobId === jobId && btn.dataset.channel === channel);
      });

      var topic = found.topic, ch = found.channel;
      var savedEdits = loadEdits(jobId, channel);
      var editing = false;
      // 텔레그램 알림 링크가 방금 준비된 원고로 바로 열리도록 해시에 남긴다(jobId:channel).
      history.replaceState(null, "", "#" + jobId + ":" + channel);

      var html = "";
      html += '<div class="doc-title">' + escapeHtmlJs(topic.keyword) + " — " + CHANNEL_LABEL[channel] + "</div>";
      html += '<div class="meta-grid">';
      html += metaRow("제목", ch.title);
      if (ch.searchDescription) html += metaRow("검색 설명", ch.searchDescription);
      if (ch.slug) html += metaRow("슬러그", ch.slug);
      if (ch.tags && ch.tags.length) html += metaRow("태그", ch.tags.join(", "));
      html += "</div>";

      html += '<div class="toolbar">';
      html += '<button type="button" class="btn" id="edit-toggle">✏️ 수정</button>';
      html += '<button type="button" class="btn primary" id="copy-body">📋 복사</button>';
      if (savedEdits) html += '<button type="button" class="btn" id="revert">↩️ 원본으로 되돌리기</button>';
      html += savedEdits ? '<span class="edited-badge">이 브라우저에서 수정됨</span>' : "";
      html += "</div>";

      html += '<div id="blocks">';
      ch.blocks.forEach(function (block, i) {
        if (block.type === "image") {
          html += '<div class="body-block image-card">';
          html += '<div class="label">🖼 이미지 위치</div>';
          html += '<div class="desc">' + escapeHtmlJs(block.description) + "</div>";
          if (block.prompt) {
            html += '<div class="prompt">' + escapeHtmlJs(block.prompt) + "</div>";
            html += '<button type="button" class="mini-copy copy-prompt" data-text="' + escapeHtmlJs(block.prompt) + '" style="margin-top:8px;">프롬프트 복사</button>';
          } else {
            html += '<div class="prompt" style="color:var(--muted);">프롬프트 미상 - 원본 원고(drafts/*.md)를 확인하세요.</div>';
          }
          html += "</div>";
        } else {
          var text = savedEdits && savedEdits[i] != null ? savedEdits[i] : block.content;
          html += '<div class="body-block text-block" data-block-index="' + i + '">' + escapeHtmlJs(text) + "</div>";
        }
      });
      html += "</div>";

      main.innerHTML = html;
      wireChannelEvents(topic, ch);
    }

    function metaRow(label, value) {
      return '<div class="k">' + label + '</div><div class="v">' + escapeHtmlJs(value) +
        '</div><button type="button" class="mini-copy copy-field" data-text="' + escapeHtmlJs(value) + '">복사</button>';
    }

    function currentBlockTexts() {
      var texts = {};
      document.querySelectorAll(".text-block").forEach(function (el) {
        texts[el.dataset.blockIndex] = el.innerText;
      });
      return texts;
    }

    function wireChannelEvents(topic, ch) {
      var jobId = topic.jobId, channel = ch.channel;

      main.querySelectorAll(".copy-field, .copy-prompt").forEach(function (btn) {
        btn.addEventListener("click", function () { copyText(btn.dataset.text); });
      });

      var editToggle = document.getElementById("edit-toggle");
      var editing = false;
      editToggle.addEventListener("click", function () {
        editing = !editing;
        editToggle.classList.toggle("active", editing);
        editToggle.textContent = editing ? "✅ 편집 종료" : "✏️ 수정";
        document.querySelectorAll(".text-block").forEach(function (el) {
          el.setAttribute("contenteditable", editing ? "true" : "false");
        });
        if (!editing) {
          var texts = currentBlockTexts();
          saveEdits(jobId, channel, texts);
          renderChannel(jobId, channel);
        }
      });

      var revertBtn = document.getElementById("revert");
      if (revertBtn) {
        revertBtn.addEventListener("click", function () {
          clearEdits(jobId, channel);
          renderChannel(jobId, channel);
        });
      }

      document.getElementById("copy-body").addEventListener("click", function () {
        var parts = [];
        document.querySelectorAll(".text-block").forEach(function (el) { parts.push(el.innerText.trim()); });
        copyText(parts.filter(Boolean).join("\\n\\n"));
      });
    }

    document.querySelectorAll(".channel-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { renderChannel(btn.dataset.jobId, btn.dataset.channel); });
    });

    // URL 해시(#jobId:channel)가 있으면 그 원고를 바로 연다(텔레그램 링크 딥링크).
    // 없거나 못 찾으면 첫 주제의 첫 채널을 기본으로 연다.
    (function openInitialChannel() {
      var hash = location.hash.replace(/^#/, "");
      if (hash) {
        var parts = hash.split(":");
        if (parts.length === 2 && findTopicChannel(parts[0], parts[1])) {
          renderChannel(parts[0], parts[1]);
          return;
        }
      }
      if (DATA.length > 0) {
        var first = DATA[0];
        var firstChannel = first.channels[0];
        if (firstChannel) renderChannel(first.jobId, firstChannel.channel);
      }
    })();
  </script>
</body>
</html>
`;
}
