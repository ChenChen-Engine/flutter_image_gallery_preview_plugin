(() => {
  const BATCH_SIZE = 160;
  const SCROLL_THRESHOLD = 720;
  const MAX_ACTIVE_ANIMATIONS = 8;

  const bridge = (() => {
    if (typeof acquireVsCodeApi === 'function') {
      const vscode = acquireVsCodeApi();
      return {
        post(message) {
          vscode.postMessage(message);
        }
      };
    }

    if (typeof window.intellijPostMessage === 'function') {
      return {
        post(message) {
          window.intellijPostMessage(message);
        }
      };
    }

    return {
      post(message) {
        console.debug('[gallery-web] no host bridge', message);
      }
    };
  })();

  const elements = {
    search: document.getElementById('searchInput'),
    platform: document.getElementById('platformFilter'),
    project: document.getElementById('projectFilter'),
    module: document.getElementById('moduleFilter'),
    type: document.getElementById('typeFilter'),
    refresh: document.getElementById('refreshButton'),
    status: document.getElementById('statusText'),
    state: document.getElementById('stateText'),
    root: document.getElementById('galleryRoot'),
    sentinel: document.getElementById('loadMoreSentinel'),
    loading: document.getElementById('loadingOverlay'),
    loadingMessage: document.getElementById('loadingMessage'),
    toast: document.getElementById('toast'),
    modal: document.getElementById('infoModal'),
    infoContent: document.getElementById('infoContent')
  };

  const contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu hidden';
  document.body.appendChild(contextMenu);

  const state = {
    all: [],
    filtered: [],
    rendered: 0,
    query: '',
    platform: 'all',
    projectName: 'all',
    moduleName: 'all',
    type: 'all',
    loading: true,
    collapsed: new Set(loadCollapsedKeys()),
    sectionNodes: new Map(),
    groupCounts: new Map(),
    infoByPath: new Map(),
    currentInfoPath: null,
    contextItem: null,
    animatedRegistry: new Map(),
    animationObserver: null,
    animationSequence: 0,
    animationUpdateTimer: 0,
    filterTimer: 0,
    scrollTimer: 0,
    toastTimer: 0
  };

  function loadCollapsedKeys() {
    try {
      const raw = window.localStorage?.getItem('imageGalleryPreview.collapsed');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveCollapsedKeys() {
    try {
      window.localStorage?.setItem('imageGalleryPreview.collapsed', JSON.stringify([...state.collapsed]));
    } catch {
      // ignore
    }
  }

  function post(type, payload = {}) {
    bridge.post({ type, ...payload });
  }

  function normalizeText(value) {
    return String(value ?? '').toLowerCase();
  }

  function fileNameOf(item) {
    const value = item.fileName || item.relPath || item.absPath || '';
    const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    return slash >= 0 ? value.substring(slash + 1) : value;
  }

  function normalizedGroupPath(groupPath) {
    return groupPath && groupPath !== '.' ? groupPath : '.';
  }

  function platformLabel(value) {
    if (value === 'android') return 'Android';
    if (value === 'flutter') return 'Flutter';
    if (value === 'ios') return 'iOS';
    return value || 'Unknown';
  }

  function platformOrder(value) {
    if (value === 'android') return 0;
    if (value === 'flutter') return 1;
    if (value === 'ios') return 2;
    return 9;
  }

  function dimensionLabel(item) {
    return item.width != null && item.height != null ? `${item.width}x${item.height}` : '-';
  }

  function setLoading(loading, message = 'Indexing assets...') {
    state.loading = !!loading;
    elements.refresh.disabled = state.loading;
    elements.loading.classList.toggle('visible', state.loading);
    elements.loadingMessage.textContent = message || 'Indexing assets...';
    elements.state.textContent = state.loading ? message : 'Ready';
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove('visible');
    }, 1600);
  }

  function sortedItems(items) {
    return [...items].sort((left, right) => (
      platformOrder(left.platform) - platformOrder(right.platform) ||
      String(left.projectName || '').localeCompare(String(right.projectName || '')) ||
      String(left.moduleName || '').localeCompare(String(right.moduleName || '')) ||
      normalizedGroupPath(left.groupPath).localeCompare(normalizedGroupPath(right.groupPath)) ||
      fileNameOf(left).localeCompare(fileNameOf(right))
    ));
  }

  function itemsForSelectedPlatform() {
    return state.platform === 'all' ? state.all : state.all.filter((item) => item.platform === state.platform);
  }

  function itemsForSelectedProject() {
    return itemsForSelectedPlatform().filter((item) => state.projectName === 'all' || item.projectName === state.projectName);
  }

  function uniqueSorted(items, selector) {
    return [...new Set(items.map(selector).filter((value) => value != null && String(value).length > 0))]
      .sort((a, b) => String(a).localeCompare(String(b)));
  }

  function replaceOptions(select, allLabel, values, currentValue) {
    const descriptors = values.map((value) => typeof value === 'string' ? { value, label: value, primary: false } : value);
    const rawValues = descriptors.map((option) => option.value);
    const safeCurrent = rawValues.includes(currentValue) ? currentValue : 'all';
    select.innerHTML = '';

    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = allLabel;
    select.appendChild(allOption);

    for (const descriptor of descriptors) {
      const option = document.createElement('option');
      option.value = descriptor.value;
      option.textContent = descriptor.label || descriptor.value;
      select.appendChild(option);
    }

    select.value = safeCurrent;
    return safeCurrent;
  }

  function updateFilterOptions() {
    const platformItems = itemsForSelectedPlatform();
    state.projectName = replaceOptions(elements.project, 'All Projects', projectOptions(platformItems), state.projectName);

    const projectItems = itemsForSelectedProject();
    state.moduleName = replaceOptions(elements.module, 'All Modules', moduleOptions(projectItems), state.moduleName);

    state.type = replaceOptions(elements.type, 'All Types', uniqueSorted(state.all, (item) => item.formatFamily), state.type);
    updateFilterVisibility();
  }

  function projectOptions(items) {
    const byName = new Map();
    for (const item of items) {
      if (!item.projectName) continue;
      const current = byName.get(item.projectName) || { value: item.projectName, primary: false };
      current.primary = current.primary || !!item.isPrimaryProject;
      byName.set(item.projectName, current);
    }
    return [...byName.values()]
      .sort((left, right) => Number(right.primary) - Number(left.primary) || left.value.localeCompare(right.value))
      .map((entry) => ({
        value: entry.value,
        label: entry.primary ? `${entry.value}（主项目）` : entry.value,
        primary: entry.primary
      }));
  }

  function moduleOptions(items) {
    const byName = new Map();
    for (const item of items) {
      if (!item.moduleName) continue;
      const current = byName.get(item.moduleName) || { value: item.moduleName, primary: false };
      current.primary = current.primary || !!item.isPrimaryModule || item.moduleName.toLowerCase() === 'app';
      byName.set(item.moduleName, current);
    }
    return [...byName.values()]
      .sort((left, right) => Number(right.primary) - Number(left.primary) || left.value.localeCompare(right.value))
      .map((entry) => ({
        value: entry.value,
        label: entry.primary ? `${entry.value}（主模块）` : entry.value,
        primary: entry.primary
      }));
  }

  function updateFilterVisibility() {
    if (state.platform === 'all') {
      elements.project.classList.add('hidden');
      elements.module.classList.add('hidden');
      return;
    }

    elements.project.classList.remove('hidden');
    if (state.platform === 'ios') {
      const moduleCount = uniqueSorted(itemsForSelectedProject(), (item) => item.moduleName).length;
      elements.module.classList.toggle('hidden', moduleCount <= 1);
    } else {
      elements.module.classList.remove('hidden');
    }
  }

  function filteredItems() {
    const query = state.query.trim().toLowerCase();
    return sortedItems(state.all.filter((item) => {
      const searchText = normalizeText(`${fileNameOf(item)} ${item.relPath || ''} ${item.md5 || ''}`);
      const matchesQuery = !query || searchText.includes(query);
      const matchesPlatform = state.platform === 'all' || item.platform === state.platform;
      const matchesProject = state.platform === 'all' || state.projectName === 'all' || item.projectName === state.projectName;
      const moduleHidden = elements.module.classList.contains('hidden');
      const matchesModule = state.platform === 'all' || moduleHidden || state.moduleName === 'all' || item.moduleName === state.moduleName;
      const matchesType = state.type === 'all' || item.formatFamily === state.type;
      return matchesQuery && matchesPlatform && matchesProject && matchesModule && matchesType;
    }));
  }

  function updateStatus() {
    elements.status.textContent = `Visible ${state.filtered.length} / Indexed ${state.all.length} · Showing ${Math.min(state.rendered, state.filtered.length)}`;
    if (!state.loading) {
      elements.state.textContent = state.rendered < state.filtered.length ? 'Scroll to load more' : 'Ready';
    }
    elements.sentinel.classList.toggle('hidden', state.filtered.length === 0 || state.rendered >= state.filtered.length);
  }

  function resetRender() {
    clearManagedAnimations();
    hideContextMenu();
    state.filtered = filteredItems();
    state.rendered = 0;
    state.sectionNodes.clear();
    rebuildGroupCounts();
    elements.root.replaceChildren();

    if (!state.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.all.length ? 'No items match current filters' : 'No indexed image resources';
      elements.root.appendChild(empty);
      updateStatus();
      return;
    }

    appendNextBatch();
  }

  function appendNextBatch() {
    if (state.rendered >= state.filtered.length) {
      updateStatus();
      return;
    }

    const end = Math.min(state.filtered.length, state.rendered + BATCH_SIZE);
    const batch = state.filtered.slice(state.rendered, end);
    const fragmentOperations = [];

    for (const item of batch) {
      const dirNode = ensureDirectoryNode(item);
      fragmentOperations.push(() => dirNode.grid.appendChild(renderCard(item)));
    }

    requestAnimationFrame(() => {
      for (const operation of fragmentOperations) {
        operation();
      }
      state.rendered = end;
      updateStatus();
      scheduleAnimationUpdate();
      if (isNearBottom()) {
        window.setTimeout(appendNextBatch, 0);
      }
    });
  }

  function sectionKey(level, parts) {
    return `${level}:${parts.map((part) => String(part ?? '').replace(/\|/g, '/')).join('|')}`;
  }

  function ensureSection(level, title, countSource, parentBody, key, className) {
    const existing = state.sectionNodes.get(key);
    if (existing) return existing;

    const isPlatform = level === 'platform';
    const section = document.createElement('section');
    section.className = `section ${className}`;
    section.dataset.key = key;
    section.classList.toggle('collapsed', !isPlatform && state.collapsed.has(key));

    const header = document.createElement(isPlatform ? 'div' : 'button');
    if (!isPlatform) header.type = 'button';
    header.className = 'section-header';

    const toggle = document.createElement('span');
    toggle.className = 'group-toggle';
    toggle.textContent = isPlatform ? '◆' : (state.collapsed.has(key) ? '▶' : '▼');

    const label = document.createElement('span');
    label.className = 'section-title';
    label.textContent = title;

    const count = document.createElement('span');
    count.className = 'section-count';
    count.textContent = countSource ? `(${countSource})` : '';

    header.appendChild(toggle);
    header.appendChild(label);
    header.appendChild(count);
    if (!isPlatform) {
      header.addEventListener('click', () => {
        if (state.collapsed.has(key)) {
          state.collapsed.delete(key);
        } else {
          state.collapsed.add(key);
        }
        saveCollapsedKeys();
        section.classList.toggle('collapsed', state.collapsed.has(key));
        toggle.textContent = state.collapsed.has(key) ? '▶' : '▼';
        scheduleAnimationUpdate();
      });
    }

    const body = document.createElement('div');
    body.className = 'section-body';
    section.appendChild(header);
    section.appendChild(body);
    parentBody.appendChild(section);

    const node = { section, body };
    state.sectionNodes.set(key, node);
    return node;
  }

  function rebuildGroupCounts() {
    state.groupCounts.clear();
    for (const item of state.filtered) {
      const directory = normalizedGroupPath(item.groupPath);
      const keys = [
        sectionKey('platform', [item.platform]),
        sectionKey('project', [item.platform, item.projectName]),
        sectionKey('module', [item.platform, item.projectName, item.moduleName]),
        sectionKey('directory', [item.platform, item.projectName, item.moduleName, directory])
      ];
      for (const key of keys) {
        state.groupCounts.set(key, (state.groupCounts.get(key) || 0) + 1);
      }
    }
  }

  function groupCount(key) {
    return state.groupCounts.get(key) || 0;
  }

  function ensureDirectoryNode(item) {
    const platformKey = sectionKey('platform', [item.platform]);
    const platformNode = ensureSection(
      'platform',
      platformLabel(item.platform),
      groupCount(platformKey),
      elements.root,
      platformKey,
      'platform'
    );

    const projectKey = sectionKey('project', [item.platform, item.projectName]);
    const projectNode = ensureSection(
      'project',
      item.projectName || 'Unknown Project',
      groupCount(projectKey),
      platformNode.body,
      projectKey,
      'project'
    );

    const moduleKey = sectionKey('module', [item.platform, item.projectName, item.moduleName]);
    const moduleNode = ensureSection(
      'module',
      item.moduleName || 'Unknown Module',
      groupCount(moduleKey),
      projectNode.body,
      moduleKey,
      'module'
    );

    const directory = normalizedGroupPath(item.groupPath);
    const directoryKey = sectionKey('directory', [item.platform, item.projectName, item.moduleName, directory]);
    const directoryNode = ensureSection(
      'directory',
      directory,
      groupCount(directoryKey),
      moduleNode.body,
      directoryKey,
      'directory'
    );

    if (!directoryNode.grid) {
      directoryNode.grid = document.createElement('div');
      directoryNode.grid.className = 'grid';
      directoryNode.body.appendChild(directoryNode.grid);
    }

    return directoryNode;
  }

  function renderCard(item) {
    const tile = document.createElement('figure');
    tile.className = 'tile';
    tile.dataset.search = `${fileNameOf(item).toLowerCase()} ${String(item.md5 || '').toLowerCase()}`;
    tile.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(item, event.clientX, event.clientY);
    });
    tile.addEventListener('dblclick', (event) => {
      if (event.target.closest('.corner-button, .open-button')) return;
      event.preventDefault();
      post('reveal', { absPath: item.absPath });
    });

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';

    const thumbButton = document.createElement('button');
    thumbButton.type = 'button';
    thumbButton.className = 'thumb-button';
    thumbButton.title = `点击复制: ${item.copyToken}`;
    let clickTimer = 0;
    thumbButton.addEventListener('click', (event) => {
      event.stopPropagation();
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => copyValue('路径', item.copyToken), 220);
    });
    thumbButton.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.clearTimeout(clickTimer);
      post('reveal', { absPath: item.absPath });
    });

    appendPreview(thumbButton, item);

    const md5Button = document.createElement('button');
    md5Button.type = 'button';
    md5Button.className = 'corner-button md5-button';
    md5Button.textContent = 'M';
    md5Button.title = `点击复制 MD5: ${item.md5}`;
    md5Button.addEventListener('click', (event) => {
      event.stopPropagation();
      copyValue('MD5', item.md5);
    });

    const infoButton = document.createElement('button');
    infoButton.type = 'button';
    infoButton.className = 'corner-button info-button';
    infoButton.textContent = 'i';
    infoButton.title = '查看图片信息';
    infoButton.addEventListener('click', (event) => {
      event.stopPropagation();
      showInfoModal(item);
    });

    thumbWrap.appendChild(thumbButton);
    thumbWrap.appendChild(md5Button);
    thumbWrap.appendChild(infoButton);

    const captionRow = document.createElement('div');
    captionRow.className = 'caption-row';

    const caption = document.createElement('figcaption');
    caption.className = 'caption';
    caption.textContent = fileNameOf(item);
    caption.title = fileNameOf(item);

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'open-button';
    openButton.textContent = 'Open';
    openButton.title = 'Open file';
    openButton.addEventListener('click', (event) => {
      event.stopPropagation();
      post('open', { absPath: item.absPath });
    });

    captionRow.appendChild(caption);
    captionRow.appendChild(openButton);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const qualifier = item.qualifier ? ` @${item.qualifier}` : '';
    meta.textContent = `${platformLabel(item.platform)} | ${item.projectName} | ${item.moduleName} | ${String(item.formatFamily || '').toUpperCase()} | ${dimensionLabel(item)}${qualifier}`;
    meta.title = item.relPath || item.absPath;

    tile.appendChild(thumbWrap);
    tile.appendChild(captionRow);
    tile.appendChild(meta);
    return tile;
  }

  function appendPreview(container, item) {
    if (item.isAnimated && ((item.renderKind === 'image' && item.previewSrc) || item.renderKind === 'lottie')) {
      registerManagedAnimation(container, item);
      return;
    }

    if (item.renderKind === 'image' && item.previewSrc) {
      const image = document.createElement('img');
      image.className = 'thumb-img';
      image.alt = fileNameOf(item);
      image.loading = 'lazy';
      image.src = item.previewSrc;
      image.addEventListener('error', () => showFailedPreview(container, item), { once: true });
      container.appendChild(image);
      return;
    }

    if (item.renderKind === 'lottie' && (item.previewSrc || item.lottieJson)) {
      const host = document.createElement('div');
      host.className = 'lottie-host';
      container.appendChild(host);
      requestAnimationFrame(() => renderLottie(host, item));
      return;
    }

    showPlaceholder(container, item);
  }

  function renderLottie(host, item) {
    try {
      if (!window.lottie) {
        showFailedPreview(host.parentElement || host, item, 'Lottie unavailable');
        return null;
      }

      const config = {
        container: host,
        renderer: 'svg',
        loop: true,
        autoplay: true
      };

      if (item.lottieJson) {
        config.animationData = typeof item.lottieJson === 'string' ? JSON.parse(item.lottieJson) : item.lottieJson;
      } else {
        config.path = item.previewSrc;
      }

      return window.lottie.loadAnimation(config);
    } catch {
      showFailedPreview(host.parentElement || host, item);
      return null;
    }
  }

  function registerManagedAnimation(container, item) {
    const id = `${item.absPath || item.relPath || 'animated'}#${state.animationSequence++}`;
    const record = {
      id,
      item,
      container,
      visible: false,
      active: false,
      priority: 0,
      sequence: state.animationSequence++,
      lottieInstance: null,
      failed: false
    };

    container.dataset.animationId = id;
    state.animatedRegistry.set(id, record);
    showAnimatedPlaceholder(container, item);
    ensureAnimationObserver().observe(container);

    const promote = () => {
      record.priority = 2;
      record.sequence = state.animationSequence++;
      scheduleAnimationUpdate();
    };
    const demote = () => {
      record.priority = 0;
      scheduleAnimationUpdate();
    };

    container.addEventListener('mouseenter', promote);
    container.addEventListener('focus', promote);
    container.addEventListener('mouseleave', demote);
    container.addEventListener('blur', demote);
  }

  function ensureAnimationObserver() {
    if (state.animationObserver) return state.animationObserver;

    if (typeof IntersectionObserver !== 'function') {
      state.animationObserver = {
        observe(target) {
          const id = target.dataset.animationId;
          const record = id ? state.animatedRegistry.get(id) : null;
          if (record) {
            record.visible = true;
            scheduleAnimationUpdate();
          }
        },
        disconnect() {}
      };
      return state.animationObserver;
    }

    state.animationObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.animationId;
        const record = id ? state.animatedRegistry.get(id) : null;
        if (record) {
          record.visible = entry.isIntersecting;
          if (entry.isIntersecting) {
            record.sequence = state.animationSequence++;
          }
        }
      }
      scheduleAnimationUpdate();
    }, {
      root: null,
      rootMargin: '260px 0px',
      threshold: 0.01
    });

    return state.animationObserver;
  }

  function scheduleAnimationUpdate() {
    if (state.animationUpdateTimer) return;
    state.animationUpdateTimer = window.requestAnimationFrame(() => {
      state.animationUpdateTimer = 0;
      updateActiveAnimations();
    });
  }

  function updateActiveAnimations() {
    if (!state.animatedRegistry.size) return;

    const candidates = [...state.animatedRegistry.values()]
      .filter((record) => !record.failed && isElementDisplayable(record.container) && (record.visible || record.priority > 0))
      .sort((left, right) => (
        right.priority - left.priority ||
        right.sequence - left.sequence
      ));
    const activeIds = new Set(candidates.slice(0, MAX_ACTIVE_ANIMATIONS).map((record) => record.id));

    for (const record of state.animatedRegistry.values()) {
      if (activeIds.has(record.id)) {
        activateManagedAnimation(record);
      } else {
        deactivateManagedAnimation(record);
      }
    }
  }

  function isElementDisplayable(element) {
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  function activateManagedAnimation(record) {
    if (record.active || record.failed) return;
    record.active = true;
    const item = record.item;

    if (item.renderKind === 'image' && item.previewSrc) {
      const image = document.createElement('img');
      image.className = 'thumb-img';
      image.alt = fileNameOf(item);
      image.decoding = 'async';
      image.src = item.previewSrc;
      image.addEventListener('error', () => {
        record.failed = true;
        record.active = false;
        showFailedPreview(record.container, item);
      }, { once: true });
      record.container.replaceChildren(image);
      return;
    }

    if (item.renderKind === 'lottie' && (item.previewSrc || item.lottieJson)) {
      const host = document.createElement('div');
      host.className = 'lottie-host';
      record.container.replaceChildren(host);
      record.lottieInstance = renderLottie(host, item);
      if (!record.lottieInstance) {
        record.failed = true;
        record.active = false;
      }
      return;
    }

    showPlaceholder(record.container, item);
  }

  function deactivateManagedAnimation(record) {
    if (!record.active) return;
    record.active = false;
    if (record.lottieInstance && typeof record.lottieInstance.destroy === 'function') {
      try {
        record.lottieInstance.destroy();
      } catch {
        // ignore animation teardown failures
      }
    }
    record.lottieInstance = null;
    if (!record.failed) {
      showAnimatedPlaceholder(record.container, record.item);
    }
  }

  function clearManagedAnimations() {
    if (state.animationUpdateTimer) {
      window.cancelAnimationFrame(state.animationUpdateTimer);
      state.animationUpdateTimer = 0;
    }
    if (state.animationObserver) {
      state.animationObserver.disconnect();
      state.animationObserver = null;
    }
    for (const record of state.animatedRegistry.values()) {
      if (record.lottieInstance && typeof record.lottieInstance.destroy === 'function') {
        try {
          record.lottieInstance.destroy();
        } catch {
          // ignore animation teardown failures
        }
      }
    }
    state.animatedRegistry.clear();
  }

  function showAnimatedPlaceholder(container, item) {
    container.replaceChildren();
    const placeholder = document.createElement('div');
    placeholder.className = 'animated-placeholder';
    const format = String(item.formatFamily || item.format || 'ANIM').toUpperCase();
    const play = document.createElement('span');
    play.className = 'animated-play';
    play.textContent = '▶';
    const label = document.createElement('span');
    label.textContent = format;
    placeholder.appendChild(play);
    placeholder.appendChild(label);
    container.appendChild(placeholder);
  }

  function showPlaceholder(container, item) {
    container.replaceChildren();
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder-thumb';
    placeholder.textContent = String(item.formatFamily || item.format || 'FILE').toUpperCase();
    container.appendChild(placeholder);
  }

  function showFailedPreview(container, item, message = 'Load Failed') {
    container.replaceChildren();
    const failed = document.createElement('div');
    failed.className = 'failed-thumb';
    failed.textContent = message;
    failed.title = `Load Failed: ${item.absPath}`;
    container.appendChild(failed);
  }

  function copyValue(label, value) {
    if (!value) return;
    post('copy', { label, value });
    showToast(`已复制${label}: ${value}`);
  }

  function showContextMenu(item, x, y) {
    state.contextItem = item;
    contextMenu.replaceChildren();

    const actions = [
      ['复制资源路径', () => copyValue('路径', item.copyToken)],
      ['复制绝对路径', () => copyValue('绝对路径', item.absPath)],
      ['复制相对路径', () => copyValue('相对路径', item.relPath)],
      ['复制 MD5', () => copyValue('MD5', item.md5)],
      ['打开并定位', () => post('reveal', { absPath: item.absPath })],
      ['显示图片信息', () => showInfoModal(item)],
      ['在系统文件管理器中显示', () => post('showInSystem', { absPath: item.absPath })]
    ];

    for (const [label, action] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'context-menu-item';
      button.textContent = label;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        hideContextMenu();
        action();
      });
      contextMenu.appendChild(button);
    }

    contextMenu.classList.remove('hidden');
    const width = contextMenu.offsetWidth || 220;
    const height = contextMenu.offsetHeight || 260;
    const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8));
    const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8));
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
  }

  function hideContextMenu() {
    state.contextItem = null;
    contextMenu.classList.add('hidden');
  }

  function fallbackInfo(item) {
    return {
      width: item.width != null ? String(item.width) : 'Unknown',
      height: item.height != null ? String(item.height) : 'Unknown',
      colorSpace: 'Unknown',
      chromaSubsampling: 'Unknown',
      bitDepth: 'Unknown',
      compressionMode: 'Unknown',
      streamSize: 'Unknown',
      fileSize: 'Unknown',
      format: String(item.format || item.formatFamily || 'Unknown').toUpperCase(),
      absPath: item.absPath || 'Unknown'
    };
  }

  function showInfoModal(item) {
    state.currentInfoPath = item.absPath;
    elements.modal.classList.remove('hidden');

    const cached = state.infoByPath.get(item.absPath) || item.imageInfo || fallbackInfo(item);
    renderInfo(cached);

    if (!state.infoByPath.has(item.absPath) || !item.imageInfo) {
      post('requestImageInfo', { absPath: item.absPath });
    }
  }

  function closeInfoModal() {
    state.currentInfoPath = null;
    elements.modal.classList.add('hidden');
  }

  function renderInfo(info) {
    const rows = [
      ['width', info.width],
      ['height', info.height],
      ['color Space', info.colorSpace],
      ['chroma subsampling', info.chromaSubsampling],
      ['bit depth', info.bitDepth],
      ['compression mode', info.compressionMode],
      ['stream size', info.streamSize],
      ['file size', info.fileSize],
      ['format', info.format],
      ['abs path', info.absPath]
    ];

    elements.infoContent.replaceChildren();
    for (const [key, value] of rows) {
      const row = document.createElement('div');
      row.className = 'info-row';
      const keyNode = document.createElement('div');
      keyNode.className = 'info-key';
      keyNode.textContent = `${key}:`;
      const valueNode = document.createElement('div');
      valueNode.className = 'info-value';
      valueNode.textContent = value == null || value === '' ? 'Unknown' : String(value);
      row.appendChild(keyNode);
      row.appendChild(valueNode);
      elements.infoContent.appendChild(row);
    }
  }

  function scheduleFilter() {
    window.clearTimeout(state.filterTimer);
    state.filterTimer = window.setTimeout(() => {
      updateFilterOptions();
      resetRender();
    }, 160);
  }

  function isNearBottom() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
    const height = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
    return scrollTop + viewport >= height - SCROLL_THRESHOLD;
  }

  function onScroll() {
    window.clearTimeout(state.scrollTimer);
    state.scrollTimer = window.setTimeout(() => {
      hideContextMenu();
      if (isNearBottom()) appendNextBatch();
      scheduleAnimationUpdate();
    }, 80);
  }

  elements.search.addEventListener('input', () => {
    state.query = elements.search.value;
    scheduleFilter();
  });

  elements.platform.addEventListener('change', () => {
    state.platform = elements.platform.value;
    state.projectName = 'all';
    state.moduleName = 'all';
    updateFilterOptions();
    resetRender();
  });

  elements.project.addEventListener('change', () => {
    state.projectName = elements.project.value;
    state.moduleName = 'all';
    updateFilterOptions();
    resetRender();
  });

  elements.module.addEventListener('change', () => {
    state.moduleName = elements.module.value;
    resetRender();
  });

  elements.type.addEventListener('change', () => {
    state.type = elements.type.value;
    resetRender();
  });

  elements.refresh.addEventListener('click', () => {
    setLoading(true, 'Indexing assets...');
    post('refresh');
  });

  elements.modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-modal]')) {
      closeInfoModal();
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeInfoModal();
      hideContextMenu();
    }
  });

  window.addEventListener('click', (event) => {
    if (!event.target.closest('.context-menu')) hideContextMenu();
  });
  contextMenu.addEventListener('click', (event) => event.stopPropagation());
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  window.galleryHostReceive = (message) => {
    const msg = typeof message === 'string' ? JSON.parse(message) : message;

    if (msg?.type === 'loadingState') {
      setLoading(!!msg.loading, msg.message || 'Indexing assets...');
      return;
    }

    if (msg?.type === 'assets') {
      state.all = Array.isArray(msg.items) ? msg.items : [];
      for (const item of state.all) {
        if (item.imageInfo) {
          state.infoByPath.set(item.absPath, item.imageInfo);
        }
      }
      setLoading(false, 'Ready');
      updateFilterOptions();
      resetRender();
      return;
    }

    if (msg?.type === 'imageInfo' && msg.absPath && msg.info) {
      state.infoByPath.set(msg.absPath, msg.info);
      if (state.currentInfoPath === msg.absPath) {
        renderInfo(msg.info);
      }
      return;
    }

    if (msg?.type === 'toast' && msg.message) {
      showToast(msg.message);
    }
  };

  setLoading(true, 'Indexing assets...');
  post('ready');
})();
