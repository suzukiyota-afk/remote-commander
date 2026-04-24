/* Remote Commander — job-based client.
 * Key idea: the browser never runs Claude; it subscribes to a server job that
 * lives beyond any single tab. Close Safari, walk around, come back → we
 * re-subscribe with ?since=N and replay what was missed. */
(() => {
  const $ = (s) => document.querySelector(s);
  const log = $('#log');
  const composer = $('#composer');
  const promptEl = $('#prompt');
  const sendBtn = $('#send');
  const cancelBtn = $('#cancelBtn');
  const fileInput = $('#fileInput');
  const attachments = $('#attachments');
  const sessionList = $('#sessionList');
  const jobList = $('#jobList');
  const drawer = $('#drawer');
  const drawerOpen = $('#drawerOpen');
  const drawerClose = $('#drawerClose');
  const newSessionBtn = $('#newSession');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const cwdChip = $('#cwdChip');
  const sessionChip = $('#sessionChip');
  const jobChip = $('#jobChip');
  const workspaceGrid = $('#workspaceGrid');
  const cwdCustomInput = $('#cwdCustom');

  const LS = {
    session: 'rc.sessionId',
    cwd: 'rc.cwd',
    cwdLabel: 'rc.cwdLabel',
    job: 'rc.activeJob',
    jobSeq: 'rc.jobSeq',
    messages: 'rc.messages',
    backend: 'rc.backend',
  };

  // When loaded from GitHub Pages (different origin from backend), the user
  // pastes the Cloudflare Tunnel URL once; we persist and prefix every fetch.
  const SELF_ORIGIN = window.location.origin;
  const IS_EXTERNAL_HOST = /\.github\.io$/i.test(window.location.host) || /\.pages\.dev$/i.test(window.location.host);
  function getBackend() {
    const saved = localStorage.getItem(LS.backend);
    if (saved) return saved.replace(/\/+$/, '');
    if (IS_EXTERNAL_HOST) return '';  // must prompt
    return SELF_ORIGIN;  // same-origin (running from the tunnel or localhost directly)
  }
  function setBackend(url) {
    const cleaned = url.trim().replace(/\/+$/, '');
    localStorage.setItem(LS.backend, cleaned);
  }
  // prefixed fetch
  const api = (path, opts) => {
    const b = getBackend();
    if (!b) {
      showBackendPrompt();
      return Promise.reject(new Error('backend URL not set'));
    }
    return fetch(b + path, opts);
  };
  function showBackendPrompt() {
    const cur = getBackend() || '';
    const v = prompt('Backend URL (Cloudflare tunnel https://…trycloudflare.com):', cur);
    if (v && /^https?:\/\//.test(v)) {
      setBackend(v);
      location.reload();
    }
  }
  window.rc_setBackend = (u) => { setBackend(u); location.reload(); };
  window.rc_getBackend = getBackend;

  const state = {
    sessionId: localStorage.getItem(LS.session) || null,
    cwd: localStorage.getItem(LS.cwd) || null,
    cwdLabel: localStorage.getItem(LS.cwdLabel) || 'ロジ',
    activeJobId: localStorage.getItem(LS.job) || null,
    activeSeq: parseInt(localStorage.getItem(LS.jobSeq) || '0', 10),
    workspaces: [],
    uploads: [],
    assistantBuf: '',
    assistantEl: null,
    currentEventSource: null,
    abortReader: null,
  };

  // ------- status bar -------
  const setStatus = (kind, text) => {
    statusDot.className = 'status-dot ' + (kind || '');
    statusText.textContent = text;
  };

  // ------- markdown -------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function md(s) {
    s = s.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, l, c) => `<pre><code class="lang-${esc(l)}">${esc(c)}</code></pre>`);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
    s = s.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)\*([^\*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // ------- messages -------
  function addTurn(role, text, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `turn ${role}`;
    const label = role === 'user' ? 'YOU' : role === 'assistant' ? 'CLAUDE' : role === 'tool' ? 'TOOL' : 'SYSTEM';
    const rendered = role === 'assistant' ? md(text || '') : esc(text || '');
    wrap.innerHTML = `<div class="role">${label}</div><div class="bubble">${rendered}</div>`;
    if (role === 'assistant' && !opts.noCopy) attachCopyBtn(wrap, () => text);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  function addTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'turn assistant typing-turn';
    wrap.innerHTML = `<div class="role">CLAUDE</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  function attachCopyBtn(turnEl, getText) {
    if (turnEl.querySelector('.bubble-actions')) return;
    const actions = document.createElement('div');
    actions.className = 'bubble-actions show';
    const btn = document.createElement('button');
    btn.className = 'chip'; btn.type = 'button'; btn.textContent = 'COPY';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(getText()); btn.textContent = 'COPIED'; btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'COPY'; btn.classList.remove('copied'); }, 1200);
      } catch {}
    });
    actions.appendChild(btn);
    turnEl.querySelector('.bubble').appendChild(actions);
  }

  // ------- message log persistence (so safari-closed tab still shows yesterday's conv) -------
  function persistMessages() {
    const nodes = Array.from(log.querySelectorAll('.turn'));
    const out = nodes.slice(-50).map((n) => {
      const role = n.classList.contains('user') ? 'user'
                  : n.classList.contains('tool') ? 'tool'
                  : n.classList.contains('system') ? 'system'
                  : 'assistant';
      const body = n.querySelector('.bubble')?.innerText || '';
      return { role, body };
    });
    try { localStorage.setItem(LS.messages, JSON.stringify({ sid: state.sessionId, items: out })); } catch {}
  }
  function restoreMessages() {
    try {
      const raw = localStorage.getItem(LS.messages);
      if (!raw) return;
      const { sid, items } = JSON.parse(raw);
      if (sid !== state.sessionId) return;
      for (const m of items) addTurn(m.role, m.body, { noCopy: true });
    } catch {}
  }

  // ------- workspaces / cwd picker -------
  async function loadWorkspaces() {
    try {
      const r = await api('/api/workspaces');
      const { workspaces, default: def } = await r.json();
      state.workspaces = workspaces;
      if (!state.cwd) { state.cwd = def; state.cwdLabel = 'ロジ'; }
      renderWorkspaces();
      updateCwdChip();
    } catch (e) { console.warn(e); }
  }
  function renderWorkspaces() {
    workspaceGrid.innerHTML = '';
    for (const w of state.workspaces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-btn' + (state.cwd === w.path ? ' active' : '') + (w.exists ? '' : ' missing');
      b.innerHTML = `<span class="ws-icon">${w.icon}</span><span class="ws-label">${w.label}</span>`;
      b.title = w.path;
      b.addEventListener('click', () => {
        state.cwd = w.path;
        state.cwdLabel = w.label;
        localStorage.setItem(LS.cwd, state.cwd);
        localStorage.setItem(LS.cwdLabel, state.cwdLabel);
        renderWorkspaces();
        updateCwdChip();
        drawer.classList.remove('open');
      });
      workspaceGrid.appendChild(b);
    }
  }
  cwdCustomInput.addEventListener('change', () => {
    const v = cwdCustomInput.value.trim();
    if (!v) return;
    state.cwd = v;
    state.cwdLabel = 'custom';
    localStorage.setItem(LS.cwd, state.cwd);
    localStorage.setItem(LS.cwdLabel, state.cwdLabel);
    renderWorkspaces();
    updateCwdChip();
  });
  function updateCwdChip() {
    const icon = (state.workspaces.find((w) => w.path === state.cwd) || {}).icon || '▣';
    cwdChip.textContent = `${icon} ${state.cwdLabel || 'custom'}`;
  }

  // ------- sessions -------
  async function refreshSessions() {
    try {
      const r = await api('/api/sessions');
      const j = await r.json();
      sessionList.innerHTML = '';
      for (const s of (j.sessions || []).slice(0, 15)) {
        const li = document.createElement('li');
        if (s.id === state.sessionId) li.classList.add('active');
        li.innerHTML = `
          <div class="s-title">${esc(s.title || '(untitled)')}</div>
          <div class="s-meta">${s.id.slice(0, 8)} · ${(s.last_used || '').slice(5, 16).replace('T', ' ')}</div>
          <button class="s-del" title="delete">×</button>`;
        li.addEventListener('click', (e) => {
          if (e.target.classList.contains('s-del')) return;
          selectSession(s.id, s.title);
          drawer.classList.remove('open');
        });
        li.querySelector('.s-del').addEventListener('click', async (e) => {
          e.stopPropagation();
          await api('/api/sessions/' + s.id, { method: 'DELETE' });
          if (state.sessionId === s.id) newSession();
          refreshSessions();
        });
        sessionList.appendChild(li);
      }
    } catch {}
  }
  function selectSession(id, title) {
    state.sessionId = id;
    localStorage.setItem(LS.session, id);
    localStorage.removeItem(LS.messages);
    log.innerHTML = '';
    sessionChip.textContent = (title || id).slice(0, 10);
    addTurn('system', `↻ resumed · ${id.slice(0, 8)}`);
    refreshSessions();
  }
  function newSession() {
    detachJob();
    state.sessionId = null;
    localStorage.removeItem(LS.session);
    localStorage.removeItem(LS.messages);
    log.innerHTML = '';
    sessionChip.textContent = 'new';
    refreshSessions();
  }

  // ------- skills — WORKSPACE-style button grid -------
  const skillGrid = $('#skillGrid');
  const skillSearch = $('#skillSearch');
  const skillCount = $('#skillCount');
  const skillToggle = $('#skillToggle');

  // Label = action verb (what it does) / Icon = geometric shape matching WORKSPACE style
  const PINNED = [
    { name: 'ppt-auto',                  ja: 'PPT作成',          icon: '▤' },
    { name: 'frontend-slides',           ja: 'HTML資料作成',     icon: '◧' },
    { name: 'frontend-design',           ja: 'UI設計',           icon: '◨' },
    { name: 'competitive-research',      ja: '競合調査',         icon: '⟡' },
    { name: 'market-research',           ja: '市場調査',         icon: '◇' },
    { name: 'deep-research',             ja: '深掘り調査',       icon: '⟐' },
    { name: 'expense-monthly',           ja: '経費申請',         icon: '¥' },
    { name: 'kamiya-expense',            ja: 'カミヤ申請',       icon: '₩' },
    { name: 'smarthr-payslip',           ja: '給与取得',         icon: '⧗' },
    { name: 'outlook-calendar',          ja: '予定確認',         icon: '▦' },
    { name: 'outlook-free-time',         ja: '空き時間検索',     icon: '▨' },
    { name: 'outlook-otp',               ja: '認証コード取得',   icon: '⚿' },
    { name: 'outlook-reschedule-notify', ja: 'リスケ通知作成',   icon: '⚠' },
    { name: 'outlook-attachment-store',  ja: '添付保存',         icon: '⬇' },
    { name: 'email-ops',                 ja: 'メール処理',       icon: '✉' },
    { name: 'slack-notify',              ja: 'Slack送信',        icon: '◎' },
    { name: 'kadou-entry',               ja: '稼働入力',         icon: '⏲' },
    { name: 'onenote-logi',              ja: 'OneNote更新',      icon: '▥' },
    { name: 'tico-logi',                 ja: 'TICOロジ更新',     icon: '⬢' },
    { name: 'instagram-post',            ja: 'Instagram投稿',    icon: '⊚' },
    { name: 'twitter-post',              ja: 'Twitter投稿',      icon: '⊗' },
    { name: 'form-outreach-mamiya',      ja: 'フォーム営業',     icon: '⇢' },
    { name: 'crosspost',                 ja: 'SNS横展開',        icon: '⊕' },
    { name: 'messages-ops',              ja: 'DM対応',           icon: '◐' },
    { name: 'knowledge-ops',             ja: 'ナレッジ整理',     icon: '⎘' },
  ];
  const pinnedByName = Object.fromEntries(PINNED.map((p) => [p.name, p]));

  // Non-pinned skills: one-line Japanese summary of what each skill does.
  // Keep each under ~18 chars so it fits a button.
  const JA_ONELINE = {
    // user-specific (Japanese skills)
    'bg-sync-a': '外部ワーク提案送信',
    'bg-sync-b': '外部ワーク返信対応',
    'bg-sync-c': 'CW系提案送信',
    'bg-sync-d': '外部ワーク統合起動',
    'instagram-auto': 'IG自動運用',
    'instagram-follower-list': 'IGフォロワー取得',
    'twitter-auto': 'X自動運用',
    'twitter-reply': 'X自動リプライ',
    'visa-doc-translate': 'ビザ書類翻訳',
    // agent / dev ops
    'agent-harness-construction': 'エージェント設計最適化',
    'agent-introspection-debugging': 'エージェント自己デバッグ',
    'agent-sort': 'ECC導入計画作成',
    'agentic-engineering': 'エージェント駆動開発',
    'ai-first-engineering': 'AI駆動開発運用',
    'ai-regression-testing': 'AI回帰テスト',
    'autonomous-loops': '自律エージェントループ',
    'continuous-agent-loop': '継続エージェントループ',
    'continuous-learning': 'セッションから学習',
    'continuous-learning-v2': 'Instinct学習',
    'eval-harness': '評価ハーネス',
    'enterprise-agent-ops': '長時間エージェント運用',
    'blueprint': '大規模プロジェクト計画',
    'claude-devfleet': '並列エージェント協調',
    'dmux-workflows': '並列エージェント(dmux)',
    'team-builder': 'チーム構成',
    'council': '4視点意思決定',
    'ralphinho-rfc-pipeline': 'RFC DAG実行',
    'santa-loop': '二重レビュー収束',
    'nanoclaw-repl': 'NanoClaw REPL',
    // claude-api / prompt / cost
    'claude-api': 'Anthropic API実装',
    'prompt-optimizer': 'プロンプト最適化',
    'cost-aware-llm-pipeline': 'LLM料金最適化',
    'token-budget-advisor': 'トークン予算',
    'strategic-compact': '戦略的compact',
    'iterative-retrieval': 'サブエージェントRAG',
    // docs / content
    'article-writing': '記事・ブログ執筆',
    'brand-voice': '発信スタイル学習',
    'content-engine': 'コンテンツ配信',
    'code-tour': 'コードツアー作成',
    'deep-research': '深掘りリサーチ',
    'competitive-research': '競合調査',
    'market-research': '市場調査',
    'research-ops': 'リサーチ運用',
    'search-first': '実装前の調査',
    'exa-search': 'Exa Web検索',
    // business ops
    'automation-audit-ops': '自動化ジョブ棚卸',
    'carrier-relationship-management': '配送業者管理',
    'customer-billing-ops': '顧客請求対応',
    'customs-trade-compliance': '関税・貿易',
    'energy-procurement': '電気・ガス調達',
    'finance-billing-ops': '収益・請求運用',
    'google-workspace-ops': 'Google Workspace操作',
    'inventory-demand-planning': '需給計画',
    'investor-materials': '投資家資料作成',
    'investor-outreach': '投資家コンタクト',
    'knowledge-ops': 'ナレッジ統合',
    'lead-intelligence': 'リード探索',
    'logistics-exception-management': '物流例外対応',
    'production-scheduling': '生産計画',
    'project-flow-ops': 'GitHub×Linear同期',
    'product-capability': 'PRD→実装計画',
    'quality-nonconformance': '品質不適合対応',
    'returns-reverse-logistics': '返品物流',
    'seo': 'SEO対応',
    'social-graph-ranker': 'SNSグラフ分析',
    'connections-optimizer': 'SNS人脈整理',
    'terminal-ops': 'リポジトリ実行',
    'unified-notifications-ops': '通知統合運用',
    // skills meta
    'configure-ecc': 'ECCインストール',
    'ecc-tools-cost-audit': 'ECC料金監査',
    'hookify-rules': '動作阻止フック作成',
    'skill-creator-v3': 'スキル作成',
    'skill-stocktake': 'スキル棚卸',
    'workspace-surface-audit': 'ワークスペース監査',
    'api-connector-builder': 'APIコネクタ追加',
    'api-design': 'REST API設計',
    'mcp-server-patterns': 'MCPサーバ構築',
    'data-scraper-agent': 'スクレイピング自動化',
    'dashboard-builder': 'ダッシュボード構築',
    'fal-ai-media': '画像/動画/音声生成',
    'manim-video': 'Manim動画作成',
    'remotion-video-creation': 'Remotion動画',
    'video-editing': '動画編集',
    'videodb': '動画DB操作',
    'ui-demo': 'UIデモ動画撮影',
    'content-hash-cache-pattern': 'ハッシュキャッシュ',
    'regex-vs-llm-structured-text': 'regex vs LLM判定',
    'coding-standards': 'コーディング規約',
    // verification
    'verification-loop': '検証ループ',
    'tdd-workflow': 'TDD',
    'e2e-testing': 'E2Eテスト',
    'security-review': 'セキュリティレビュー',
    'security-scan': 'Claude設定監査',
    'security-bounty-hunter': 'バグ報奨金ハント',
    'plankton-code-quality': '書込時コード品質',
    // compliance
    'hipaa-compliance': 'HIPAA準拠',
    'healthcare-phi-compliance': '医療PHI準拠',
    'defi-amm-security': 'DeFi AMM監査',
    'llm-trading-agent-security': '自律取引セキュリティ',
    'evm-token-decimals': 'EVM小数対応',
    'nodejs-keccak256': 'Node Keccak256',
    // frontend / mobile
    'liquid-glass-design': 'iOS26 Liquid Glass',
    'foundation-models-on-device': 'Apple端末LLM',
    'compose-multiplatform-patterns': 'Compose MP',
    'android-clean-architecture': 'Androidクリーンアーキ',
    // Platforms
    'google-workspace-ops': 'Google Workspace',
    'trello-microsoft': 'Trello×MS連携',
    'jira-integration': 'Jira連携',
    'github-ops': 'GitHub操作',
    'x-api': 'X/Twitter API',
    'nutrient-document-processing': 'OCR・書類変換',
    // lang patterns
    'python-patterns': 'Python設計',
    'python-testing': 'Pythonテスト',
    'typescript-patterns': 'TS設計',
    'golang-patterns': 'Go設計',
    'golang-testing': 'Goテスト',
    'rust-patterns': 'Rust設計',
    'rust-testing': 'Rustテスト',
    'kotlin-patterns': 'Kotlin設計',
    'kotlin-testing': 'Kotlinテスト',
    'kotlin-coroutines-flows': 'Kotlin Coroutine',
    'kotlin-ktor-patterns': 'Ktor Server',
    'kotlin-exposed-patterns': 'Exposed ORM',
    'swift-concurrency-6-2': 'Swift並行処理',
    'swift-actor-persistence': 'Swift actor永続化',
    'swift-protocol-di-testing': 'Swift Protocol DI',
    'swiftui-patterns': 'SwiftUI設計',
    'dart-flutter-patterns': 'Flutter設計',
    'java-coding-standards': 'Java規約',
    'cpp-coding-standards': 'C++規約',
    'cpp-testing': 'C++テスト',
    'csharp-testing': 'C#テスト',
    'dotnet-patterns': '.NETパターン',
    'perl-patterns': 'Perl設計',
    'perl-security': 'Perlセキュリティ',
    'perl-testing': 'Perlテスト',
    // frameworks
    'django-patterns': 'Django設計',
    'django-security': 'Djangoセキュリティ',
    'django-tdd': 'Django TDD',
    'django-verification': 'Django検証',
    'laravel-patterns': 'Laravel設計',
    'laravel-plugin-discovery': 'Laravel拡張',
    'laravel-security': 'Laravelセキュリティ',
    'laravel-tdd': 'Laravel TDD',
    'laravel-verification': 'Laravel検証',
    'springboot-patterns': 'Spring Boot設計',
    'springboot-security': 'Spring Security',
    'springboot-tdd': 'Spring Boot TDD',
    'springboot-verification': 'Spring Boot検証',
    'jpa-patterns': 'JPA設計',
    'nestjs-patterns': 'NestJS設計',
    'backend-patterns': 'バックエンド設計',
    'frontend-patterns': 'フロントエンド設計',
    // infra
    'database-migrations': 'DBマイグレーション',
    'postgres-patterns': 'PostgreSQL設計',
    'clickhouse-io': 'ClickHouse運用',
    'docker-patterns': 'Docker設計',
    'deployment-patterns': 'デプロイパターン',
  };
  function subtitleFor(name, desc) {
    const t = JA_ONELINE[name];
    if (t) return t;
    if (!desc) return '';
    // Fallback: use first sentence / first 26 chars of the raw description
    const s = desc.split(/[.。\n]/)[0].trim();
    return s.length > 26 ? s.slice(0, 26) + '…' : s;
  }

  function iconFor(name) {
    const p = pinnedByName[name];
    if (p) return p.icon;
    const pairs = [
      [/ppt|slides?/i, '▤'],
      [/outlook|email|mail/i, '✉'],
      [/research|exa|search-first/i, '⟡'],
      [/expense|billing|finance/i, '¥'],
      [/smarthr|hr\b/i, '⧗'],
      [/onenote|tico|kadou/i, '▥'],
      [/slack|messages?-ops/i, '◎'],
      [/instagram|twitter|x-api|social|crosspost/i, '⚇'],
      [/form-outreach|bg-sync|scrap/i, '⇢'],
      [/plaud|zoom|video|audio|meeting/i, '⏺'],
      [/github|jira|trello|linear/i, '⎔'],
      [/frontend|design|react|nextjs/i, '◧'],
      [/backend|server|api/i, '▣'],
      [/review|test|tdd|verify|quality|gate/i, '✓'],
      [/security|audit|compliance|hipaa|phi/i, '⚔'],
      [/python|typescript|golang|rust|kotlin|swift|dart|flutter|java|php|perl|csharp|cpp/i, '⌁'],
      [/skill|configure|init|harness|agent/i, '✦'],
      [/database|postgres|clickhouse|migration|jpa|exposed/i, '⎕'],
      [/deploy|docker|ci-?cd/i, '▲'],
      [/outreach|connections|investor|lead|pitch/i, '◇'],
    ];
    for (const [re, ic] of pairs) if (re.test(name)) return ic;
    return '◆';
  }

  state.skills = [];
  state.showAll = false;

  async function loadSkills() {
    try {
      const r = await api('/api/skills');
      const j = await r.json();
      state.skills = j.skills || [];
      skillCount.textContent = `(${state.skills.length})`;
      renderSkills(skillSearch.value);
    } catch {}
  }

  function renderSkills(filter) {
    const q = (filter || '').trim().toLowerCase();
    skillGrid.innerHTML = '';
    let items;
    if (q) {
      items = state.skills.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q));
    } else if (state.showAll) {
      items = state.skills;
    } else {
      const names = new Set(state.skills.map((s) => s.name));
      items = PINNED.filter((p) => names.has(p.name)).map((p) => ({
        name: p.name, description: (state.skills.find((s) => s.name === p.name) || {}).description,
      }));
    }
    for (const s of items.slice(0, 250)) {
      const meta = pinnedByName[s.name];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skill-btn' + (meta ? ' pinned' : '');
      btn.title = `/${s.name}${s.description ? '\n' + s.description : ''}`;
      if (meta) {
        // Pinned: single line Japanese verb label
        btn.innerHTML = `<span class="sb-icon">${iconFor(s.name)}</span><span class="sb-name ja">${esc(meta.ja)}</span>`;
      } else {
        // Non-pinned: Japanese one-liner (what it does) + small slug underneath
        const ja = subtitleFor(s.name, s.description);
        const hasJa = !!JA_ONELINE[s.name];
        btn.innerHTML = `
          <span class="sb-icon">${iconFor(s.name)}</span>
          <span class="sb-name ${hasJa ? 'ja' : ''}">${esc(ja || s.name)}</span>
          ${hasJa ? `<span class="sb-sub">${esc(s.name)}</span>` : ''}
        `;
      }
      btn.addEventListener('click', () => {
        const cur = promptEl.value;
        const needsSpace = cur && !cur.endsWith(' ');
        promptEl.value = (needsSpace ? cur + ' ' : cur) + '/' + s.name + ' ';
        promptEl.focus();
        autosize();
        drawer.classList.remove('open');
      });
      skillGrid.appendChild(btn);
    }
  }
  skillSearch.addEventListener('input', () => renderSkills(skillSearch.value));
  skillToggle.addEventListener('click', () => {
    state.showAll = !state.showAll;
    skillToggle.classList.toggle('on', state.showAll);
    skillToggle.textContent = state.showAll ? 'pinned' : 'all';
    renderSkills(skillSearch.value);
  });

  // ------- jobs list -------
  async function refreshJobs() {
    try {
      const r = await api('/api/jobs?limit=10');
      const j = await r.json();
      jobList.innerHTML = '';
      for (const job of j.jobs || []) {
        const li = document.createElement('li');
        li.className = 'job-item ' + job.status;
        if (job.id === state.activeJobId) li.classList.add('active');
        li.innerHTML = `
          <div class="j-title">${esc(job.title)}</div>
          <div class="j-meta">
            <span class="j-status">${job.status}</span>
            <span>${(job.created_at || '').slice(11, 16)}</span>
            <span>${job.event_count}ev</span>
          </div>
          ${job.preview ? `<div class="j-preview">${esc(job.preview)}</div>` : ''}`;
        li.addEventListener('click', () => {
          attachJob(job.id, 0, { restore: true });
          drawer.classList.remove('open');
        });
        jobList.appendChild(li);
      }
    } catch {}
  }

  // ------- attachments / uploads -------
  async function uploadFile(file) {
    const fd = new FormData(); fd.append('file', file);
    const r = await api('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload failed');
    return await r.json();
  }
  function renderAttachments() {
    attachments.innerHTML = '';
    for (const a of state.uploads) {
      const div = document.createElement('div');
      div.className = 'attachment';
      div.innerHTML = `<img src="${getBackend()}${a.url}" alt=""><button type="button" aria-label="remove">×</button>`;
      div.querySelector('button').addEventListener('click', () => {
        state.uploads = state.uploads.filter((x) => x !== a);
        renderAttachments();
      });
      attachments.appendChild(div);
    }
  }
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files || []) {
      try { state.uploads.push(await uploadFile(f)); }
      catch (e) { addTurn('system', 'upload failed: ' + e.message); }
    }
    fileInput.value = '';
    renderAttachments();
  });

  // ------- job subscription (SSE via fetch) -------
  function detachJob() {
    if (state.abortReader) {
      try { state.abortReader.abort(); } catch {}
      state.abortReader = null;
    }
    state.activeJobId = null;
    state.activeSeq = 0;
    localStorage.removeItem(LS.job);
    localStorage.removeItem(LS.jobSeq);
    cancelBtn.hidden = true;
    sendBtn.disabled = false;
    jobChip.hidden = true;
    setStatus('ok', 'ready');
  }

  async function attachJob(jobId, since = 0, opts = {}) {
    // Tear down old subscription
    if (state.abortReader) { try { state.abortReader.abort(); } catch {} }
    state.activeJobId = jobId;
    state.activeSeq = since;
    localStorage.setItem(LS.job, jobId);
    localStorage.setItem(LS.jobSeq, String(since));

    if (opts.restore) {
      // coming from the job-list panel → clear log and rebuild from full history
      log.innerHTML = '';
      since = 0;
      state.activeSeq = 0;
    }

    cancelBtn.hidden = false;
    sendBtn.disabled = true;
    jobChip.hidden = false;
    jobChip.textContent = 'job ' + jobId.slice(0, 6) + ' · live';
    setStatus('run', 'streaming');

    state.assistantEl = null;
    state.assistantBuf = '';

    const controller = new AbortController();
    state.abortReader = controller;

    try {
      const r = await api(`/api/jobs/${jobId}/events?since=${since}`, { signal: controller.signal });
      if (!r.ok) { addTurn('system', 'job events HTTP ' + r.status); detachJob(); return; }
      const reader = r.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const chunk of parts) {
          const line = chunk.trim();
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          let ev;
          try { ev = JSON.parse(json); } catch { continue; }
          onEvent(ev);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        // network blip or Safari put us to sleep — leave activeJobId so we can reconnect
        setStatus('err', 'disconnected (tap to resume)');
        cancelBtn.hidden = true;
      }
    }
  }

  function onEvent(ev) {
    // remember seq so we can reconnect after Safari backgrounds
    if (typeof ev.seq === 'number') {
      state.activeSeq = ev.seq + 1;
      localStorage.setItem(LS.jobSeq, String(state.activeSeq));
    }

    if (ev.type === 'job_meta') {
      if (ev.session_id) {
        state.sessionId = ev.session_id;
        localStorage.setItem(LS.session, ev.session_id);
        sessionChip.textContent = ev.session_id.slice(0, 8);
      }
      if (ev.cwd) {
        const ws = state.workspaces.find((w) => w.path === ev.cwd);
        state.cwdLabel = ws ? ws.label : 'custom';
        updateCwdChip();
      }
      if (ev.status && ev.status !== 'running') {
        // finished job — still render history, then detach at end
      }
      return;
    }
    if (ev.type === 'stderr') return; // hide from UI
    if (ev.type === 'error') { addTurn('system', 'error: ' + ev.error); return; }
    if (ev.type === 'done') {
      jobChip.textContent = 'job ' + (state.activeJobId || '').slice(0, 6) + ' · ' + (ev.status || 'done');
      jobChip.className = 'job-chip ' + (ev.status || 'done');
      sendBtn.disabled = false;
      cancelBtn.hidden = true;
      setStatus('ok', ev.status === 'canceled' ? 'canceled' : 'ready');
      state.abortReader = null;
      localStorage.removeItem(LS.job);
      localStorage.removeItem(LS.jobSeq);
      state.activeJobId = null;
      persistMessages();
      refreshSessions(); refreshJobs();
      return;
    }

    // --- claude stream-json events ---
    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) {
        state.sessionId = ev.session_id;
        localStorage.setItem(LS.session, ev.session_id);
        sessionChip.textContent = ev.session_id.slice(0, 8);
      }
      return;
    }
    if (ev.type === 'stream_event') {
      const d = ev.event?.delta;
      if (d?.type === 'text_delta' && d.text) {
        if (!state.assistantEl) state.assistantEl = addTurn('assistant', '', { noCopy: true });
        state.assistantBuf += d.text;
        state.assistantEl.querySelector('.bubble').innerHTML = md(state.assistantBuf);
        attachCopyBtn(state.assistantEl, () => state.assistantBuf);
        log.scrollTop = log.scrollHeight;
      }
      return;
    }
    if (ev.type === 'assistant') {
      const content = ev.message?.content || [];
      for (const c of content) {
        if (c.type === 'tool_use') {
          const name = c.name || 'tool';
          let input = '';
          if (c.input) {
            if (c.input.command) input = String(c.input.command).slice(0, 120);
            else if (c.input.file_path) input = c.input.file_path;
            else if (c.input.path) input = c.input.path;
            else input = JSON.stringify(c.input).slice(0, 120);
          }
          addTurn('tool', `→ ${name}: ${input}`);
        }
      }
      return;
    }
    if (ev.type === 'user') {
      const content = ev.message?.content || [];
      for (const c of content) {
        if (c.type === 'tool_result') {
          const out = typeof c.content === 'string' ? c.content : JSON.stringify(c.content).slice(0, 400);
          addTurn('tool', '← ' + out.slice(0, 300));
        }
      }
      return;
    }
    if (ev.type === 'result') {
      if (ev.is_error) addTurn('system', 'error: ' + (ev.result || 'unknown'));
      // commit current assistant buffer as final
      if (state.assistantEl && ev.result) {
        state.assistantBuf = ev.result;
        state.assistantEl.querySelector('.bubble').innerHTML = md(ev.result);
        attachCopyBtn(state.assistantEl, () => ev.result);
      }
      state.assistantEl = null;
      state.assistantBuf = '';
      persistMessages();
      return;
    }
  }

  // ------- send -------
  async function send() {
    if (state.activeJobId) return;
    const prompt = promptEl.value.trim();
    if (!prompt && !state.uploads.length) return;

    addTurn('user', prompt + (state.uploads.length ? `\n[${state.uploads.length}枚添付]` : ''));
    promptEl.value = ''; autosize();

    const body = {
      prompt,
      session_id: state.sessionId,
      cwd: state.cwd || undefined,
      image_paths: state.uploads.map((u) => u.path),
    };
    state.uploads = []; renderAttachments();

    addTyping();  // transient; removed when first delta arrives

    try {
      const r = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { job_id, session_id } = await r.json();
      state.sessionId = session_id;
      localStorage.setItem(LS.session, session_id);
      sessionChip.textContent = session_id.slice(0, 8);
      // Remove typing indicator; the stream will add the real assistant bubble
      const typing = log.querySelector('.typing-turn');
      if (typing) typing.remove();
      await attachJob(job_id, 0);
    } catch (e) {
      addTurn('system', 'send failed: ' + e.message);
      sendBtn.disabled = false;
    }
  }

  cancelBtn.addEventListener('click', async () => {
    if (!state.activeJobId) return;
    try { await api(`/api/jobs/${state.activeJobId}/cancel`, { method: 'POST' }); } catch {}
  });

  // ------- textarea -------
  function autosize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
  }
  promptEl.addEventListener('input', autosize);
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });
  composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });

  // ------- drawer -------
  drawerOpen.addEventListener('click', () => { drawer.classList.add('open'); refreshJobs(); });
  drawerClose.addEventListener('click', () => drawer.classList.remove('open'));
  newSessionBtn.addEventListener('click', () => { newSession(); drawer.classList.remove('open'); });
  document.addEventListener('click', (e) => {
    if (!drawer.classList.contains('open')) return;
    if (drawer.contains(e.target) || drawerOpen.contains(e.target)) return;
    drawer.classList.remove('open');
  });

  // ------- visibility: when we come back to the tab, reconnect any live job -------
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.activeJobId && !state.abortReader) {
      setStatus('run', 'reconnecting…');
      attachJob(state.activeJobId, state.activeSeq);
    }
  });
  window.addEventListener('focus', () => {
    if (state.activeJobId && !state.abortReader) attachJob(state.activeJobId, state.activeSeq);
  });
  window.addEventListener('online', () => {
    if (state.activeJobId && !state.abortReader) attachJob(state.activeJobId, state.activeSeq);
  });

  // ------- service worker -------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }

  // ------- init -------
  async function init() {
    try {
      const h = await api('/api/health').then((r) => r.json());
      setStatus('ok', h.active_jobs ? `ready · ${h.active_jobs} running` : 'ready');
    } catch { setStatus('err', 'offline'); }

    await loadWorkspaces();
    await refreshSessions();
    await refreshJobs();
    loadSkills();

    if (state.sessionId) sessionChip.textContent = state.sessionId.slice(0, 8);

    // restore old chat log
    restoreMessages();

    // if we were streaming a job last time, reconnect
    if (state.activeJobId) {
      setStatus('run', 'resuming job…');
      attachJob(state.activeJobId, state.activeSeq);
    }
  }
  init();
})();
