(() => {
  const BATCH_SIZE = 160;
  const SCROLL_THRESHOLD = 720;
  const MAX_ACTIVE_ANIMATIONS = 8;
  const DEFAULT_TILE_SIZE = 144;
  const MIN_TILE_SIZE = 96;
  const MAX_TILE_SIZE = 192;
  const TILE_SIZE_STEP = 16;

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
    mediaType: document.getElementById('mediaTypeFilter'),
    format: document.getElementById('formatFilter'),
    zoomOut: document.getElementById('zoomOutButton'),
    zoomIn: document.getElementById('zoomInButton'),
    zoomReset: document.getElementById('zoomResetButton'),
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
    mediaType: 'all',
    format: 'all',
    tileSize: loadTileSize(),
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

  function loadTileSize() {
    try {
      const raw = Number(window.localStorage?.getItem('imageGalleryPreview.tileSize'));
      return clampTileSize(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TILE_SIZE);
    } catch {
      return DEFAULT_TILE_SIZE;
    }
  }

  function saveTileSize() {
    try {
      window.localStorage?.setItem('imageGalleryPreview.tileSize', String(state.tileSize));
    } catch {
      // ignore
    }
  }

  function clampTileSize(value) {
    return Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, value));
  }

  function applyTileSize() {
    document.documentElement.style.setProperty('--tile-min', `${state.tileSize}px`);
    elements.zoomOut.disabled = state.tileSize <= MIN_TILE_SIZE;
    elements.zoomIn.disabled = state.tileSize >= MAX_TILE_SIZE;
    elements.zoomReset.disabled = state.tileSize === DEFAULT_TILE_SIZE;
    scheduleAnimationUpdate();
  }

  function setTileSize(value) {
    state.tileSize = clampTileSize(value);
    saveTileSize();
    applyTileSize();
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

  function mediaTypeLabel(value) {
    if (value === 'image') return '图片';
    if (value === 'audio') return '音频';
    if (value === 'video') return '视频';
    return value || 'Unknown';
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
      Number(!!right.isPrimaryProject) - Number(!!left.isPrimaryProject) ||
      String(left.projectName || '').localeCompare(String(right.projectName || '')) ||
      String(left.projectRelPath || '').localeCompare(String(right.projectRelPath || '')) ||
      Number(!!right.isPrimaryModule) - Number(!!left.isPrimaryModule) ||
      String(left.moduleName || '').localeCompare(String(right.moduleName || '')) ||
      String(left.moduleRelPath || '').localeCompare(String(right.moduleRelPath || '')) ||
      normalizedGroupPath(left.groupPath).localeCompare(normalizedGroupPath(right.groupPath)) ||
      fileNameOf(left).localeCompare(fileNameOf(right))
    ));
  }

  function itemsForSelectedPlatform() {
    return state.platform === 'all' ? state.all : state.all.filter((item) => item.platform === state.platform);
  }

  function itemsForSelectedProject() {
    return itemsForSelectedPlatform().filter((item) => state.projectName === 'all' || projectKey(item) === state.projectName);
  }

  function itemsForSelectedModule() {
    return itemsForSelectedProject().filter((item) => {
      const moduleHidden = elements.module.classList.contains('hidden');
      return moduleHidden || state.moduleName === 'all' || moduleKey(item) === state.moduleName;
    });
  }

  function projectKey(item) {
    return item.projectPath || item.projectName || '';
  }

  function moduleKey(item) {
    return item.modulePath || item.moduleName || '';
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
      if (descriptor.title) option.title = descriptor.title;
      select.appendChild(option);
    }

    select.value = safeCurrent;
    const selectedDescriptor = descriptors.find((descriptor) => descriptor.value === safeCurrent);
    select.title = selectedDescriptor?.title || '';
    return safeCurrent;
  }

  function updateFilterOptions() {
    const platformItems = itemsForSelectedPlatform();
    const projectOptionItems = filterByMediaAndFormat(platformItems);
    state.projectName = replaceOptions(elements.project, 'All Projects', projectOptions(projectOptionItems), state.projectName);

    const projectItems = itemsForSelectedProject();
    const moduleOptionItems = filterByMediaAndFormat(projectItems);
    state.moduleName = replaceOptions(elements.module, 'All Modules', moduleOptions(moduleOptionItems), state.moduleName);

    const moduleItems = itemsForSelectedModule();
    state.mediaType = replaceOptions(
      elements.mediaType,
      'All Media',
      uniqueSorted(moduleItems, (item) => item.mediaType || 'image').map((value) => ({
        value,
        label: mediaTypeLabel(value)
      })),
      state.mediaType
    );

    const mediaItems = moduleItems.filter((item) => state.mediaType === 'all' || (item.mediaType || 'image') === state.mediaType);
    state.format = replaceOptions(elements.format, 'All Formats', uniqueSorted(mediaItems, (item) => item.formatFamily), state.format);
    updateFilterVisibility();
  }

  function filterByMediaAndFormat(items) {
    return items.filter((item) => {
      const matchesMediaType = state.mediaType === 'all' || (item.mediaType || 'image') === state.mediaType;
      const matchesFormat = state.format === 'all' || item.formatFamily === state.format;
      return matchesMediaType && matchesFormat;
    });
  }

  function projectOptions(items) {
    const byKey = new Map();
    for (const item of items) {
      if (!item.projectName) continue;
      const key = projectKey(item);
      const current = byKey.get(key) || {
        value: key,
        name: item.projectName,
        relPath: item.projectRelPath || '.',
        primary: false
      };
      current.primary = current.primary || !!item.isPrimaryProject;
      byKey.set(key, current);
    }
    const nameCounts = countOptionNames(byKey);
    return [...byKey.values()]
      .sort((left, right) => Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name) || left.relPath.localeCompare(right.relPath))
      .map((entry) => ({
        value: entry.value,
        label: optionLabel(entry.name, entry.relPath, !!entry.primary, '主项目', (nameCounts.get(entry.name) || 0) > 1),
        primary: entry.primary,
        title: entry.relPath
      }));
  }

  function moduleOptions(items) {
    const byKey = new Map();
    for (const item of items) {
      if (!item.moduleName) continue;
      const key = moduleKey(item);
      const current = byKey.get(key) || {
        value: key,
        name: item.moduleName,
        relPath: item.moduleRelPath || '.',
        primary: false
      };
      current.primary = current.primary || !!item.isPrimaryModule || item.moduleName.toLowerCase() === 'app';
      byKey.set(key, current);
    }
    const nameCounts = countOptionNames(byKey);
    return [...byKey.values()]
      .sort((left, right) => Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name) || left.relPath.localeCompare(right.relPath))
      .map((entry) => ({
        value: entry.value,
        label: optionLabel(entry.name, entry.relPath, !!entry.primary, '主模块', (nameCounts.get(entry.name) || 0) > 1),
        primary: entry.primary,
        title: entry.relPath
      }));
  }

  function optionLabel(name, relPath, primary, primaryText, duplicated) {
    const suffix = duplicated && relPath && relPath !== '.' ? ` · ${relPath}` : '';
    return `${name}${suffix}${primary ? `（${primaryText}）` : ''}`;
  }

  function countOptionNames(byKey) {
    const counts = new Map();
    for (const entry of byKey.values()) {
      counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
    }
    return counts;
  }

  function updateFilterVisibility() {
    if (state.platform === 'all') {
      elements.project.classList.add('hidden');
      elements.module.classList.add('hidden');
      return;
    }

    elements.project.classList.remove('hidden');
    if (state.platform === 'ios') {
      const moduleCount = uniqueSorted(itemsForSelectedProject(), moduleKey).length;
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
      const matchesProject = state.platform === 'all' || state.projectName === 'all' || projectKey(item) === state.projectName;
      const moduleHidden = elements.module.classList.contains('hidden');
      const matchesModule = state.platform === 'all' || moduleHidden || state.moduleName === 'all' || moduleKey(item) === state.moduleName;
      const matchesMediaType = state.mediaType === 'all' || (item.mediaType || 'image') === state.mediaType;
      const matchesFormat = state.format === 'all' || item.formatFamily === state.format;
      return matchesQuery && matchesPlatform && matchesProject && matchesModule && matchesMediaType && matchesFormat;
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
    const canCollapse = !isPlatform || state.platform === 'all';
    const section = document.createElement('section');
    section.className = `section ${className}`;
    section.dataset.key = key;
    section.classList.toggle('collapsible', canCollapse);
    section.classList.toggle('collapsed', canCollapse && state.collapsed.has(key));

    const header = document.createElement(canCollapse ? 'button' : 'div');
    if (canCollapse) header.type = 'button';
    header.className = 'section-header';

    const toggle = document.createElement('span');
    toggle.className = 'group-toggle';
    toggle.textContent = canCollapse ? (state.collapsed.has(key) ? '▶' : '▼') : '◆';

    const label = document.createElement('span');
    label.className = 'section-title';
    label.textContent = title;

    const count = document.createElement('span');
    count.className = 'section-count';
    count.textContent = countSource ? `(${countSource})` : '';

    header.appendChild(toggle);
    header.appendChild(label);
    header.appendChild(count);
    if (canCollapse) {
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
        sectionKey('project', [item.platform, projectKey(item)]),
        sectionKey('module', [item.platform, projectKey(item), moduleKey(item)]),
        sectionKey('directory', [item.platform, projectKey(item), moduleKey(item), directory])
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

    const projectSectionKey = sectionKey('project', [item.platform, projectKey(item)]);
    const projectNode = ensureSection(
      'project',
      item.projectName || 'Unknown Project',
      groupCount(projectSectionKey),
      platformNode.body,
      projectSectionKey,
      'project'
    );

    const moduleSectionKey = sectionKey('module', [item.platform, projectKey(item), moduleKey(item)]);
    const moduleNode = ensureSection(
      'module',
      item.moduleName || 'Unknown Module',
      groupCount(moduleSectionKey),
      projectNode.body,
      moduleSectionKey,
      'module'
    );

    const directory = normalizedGroupPath(item.groupPath);
    const directoryKey = sectionKey('directory', [item.platform, projectKey(item), moduleKey(item), directory]);
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
    infoButton.title = '查看媒体信息';
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

    tile.appendChild(thumbWrap);
    tile.appendChild(captionRow);
    return tile;
  }

  function appendPreview(container, item) {
    if (item.renderKind === 'audio') {
      appendAudioPreview(container, item);
      return;
    }

    if (item.renderKind === 'video') {
      appendVideoPreview(container, item);
      return;
    }

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

  function appendAudioPreview(container, item) {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-placeholder audio-placeholder';
    const icon = document.createElement('div');
    icon.className = 'media-icon';
    icon.textContent = '♪';
    const label = document.createElement('div');
    label.textContent = String(item.formatFamily || 'AUDIO').toUpperCase();
    const play = document.createElement('span');
    play.className = 'media-play-button';
    play.textContent = '▶';
    play.title = '播放 / 停止';
    const duration = durationBadge(item);

    let audio = null;
    play.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!item.previewSrc) return;
      if (!audio) {
        audio = new Audio(item.previewSrc);
        audio.addEventListener('loadedmetadata', () => updateDuration(item, duration, audio.duration));
        audio.addEventListener('ended', () => {
          play.textContent = '▶';
        });
      }
      if (audio.paused) {
        audio.play().then(() => {
          play.textContent = '■';
        }).catch(() => showToast('音频播放失败'));
      } else {
        audio.pause();
        audio.currentTime = 0;
        play.textContent = '▶';
      }
    });

    wrapper.appendChild(icon);
    wrapper.appendChild(label);
    wrapper.appendChild(play);
    wrapper.appendChild(duration);
    container.appendChild(wrapper);
  }

  function appendVideoPreview(container, item) {
    const wrapper = document.createElement('div');
    wrapper.className = 'media-placeholder video-placeholder';
    if (item.previewSrc) {
      const video = document.createElement('video');
      video.className = 'thumb-img';
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.src = item.previewSrc;
      video.addEventListener('loadedmetadata', () => updateDuration(item, duration, video.duration));
      video.addEventListener('error', () => {
        if (!wrapper.querySelector('.media-icon')) {
          const icon = document.createElement('div');
          icon.className = 'media-icon';
          icon.textContent = '▣';
          wrapper.prepend(icon);
        }
      }, { once: true });
      wrapper.appendChild(video);
    } else {
      const icon = document.createElement('div');
      icon.className = 'media-icon';
      icon.textContent = '▣';
      wrapper.appendChild(icon);
    }

    const play = document.createElement('span');
    play.className = 'media-play-button';
    play.textContent = '▶';
    play.title = '打开视频';
    play.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      post('reveal', { absPath: item.absPath });
    });
    const duration = durationBadge(item);
    wrapper.appendChild(play);
    wrapper.appendChild(duration);
    container.appendChild(wrapper);
  }

  function durationBadge(item) {
    const duration = document.createElement('span');
    duration.className = 'duration-badge';
    duration.textContent = item.durationLabel || '';
    duration.classList.toggle('hidden', !duration.textContent);
    return duration;
  }

  function updateDuration(item, badge, seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const text = formatDuration(seconds);
    item.durationLabel = text;
    badge.textContent = text;
    badge.classList.remove('hidden');
  }

  function formatDuration(seconds) {
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
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
      ['显示媒体信息', () => showInfoModal(item)],
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
      mediaType: item.mediaType || 'image',
      source: 'Built-in',
      sections: [
        {
          title: item.mediaType === 'video' ? 'Video' : item.mediaType === 'audio' ? 'Audio' : 'Image',
          rows: [
            { label: 'format', value: String(item.format || item.formatFamily || 'Unknown').toUpperCase() },
            { label: 'duration', value: item.durationLabel || 'Unknown' },
            { label: 'abs path', value: item.absPath || 'Unknown' }
          ]
        }
      ]
    };
  }

  function showInfoModal(item) {
    state.currentInfoPath = item.absPath;
    elements.modal.classList.remove('hidden');

    const cached = state.infoByPath.get(item.absPath) || item.mediaInfo || item.imageInfo || fallbackInfo(item);
    renderInfo(cached);

    if (!state.infoByPath.has(item.absPath) || (!item.mediaInfo && !item.imageInfo)) {
      post('requestImageInfo', { absPath: item.absPath });
    }
  }

  function closeInfoModal() {
    state.currentInfoPath = null;
    elements.modal.classList.add('hidden');
  }

  function renderInfo(info) {
    elements.infoContent.replaceChildren();
    const normalized = normalizeInfo(info);
    const source = document.createElement('div');
    source.className = 'info-source';
    source.textContent = `Source: ${normalized.source || 'Unknown'}`;
    elements.infoContent.appendChild(source);

    for (const section of normalized.sections) {
      const sectionNode = document.createElement('section');
      sectionNode.className = 'info-section';
      const title = document.createElement('h3');
      title.className = 'info-section-title';
      title.textContent = section.title || 'Info';
      sectionNode.appendChild(title);

      for (const entry of section.rows || []) {
        sectionNode.appendChild(renderInfoRow(entry.label, entry.value));
      }
      elements.infoContent.appendChild(sectionNode);
    }

    if (normalized.installHint) {
      const hint = document.createElement('div');
      hint.className = 'info-install-hint';
      const text = document.createElement('span');
      text.textContent = normalized.installHint.text || '安装 MediaInfo 可解析更多数据';
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'info-link';
      link.textContent = normalized.installHint.actionLabel || '去下载';
      link.addEventListener('click', () => post('openExternal', { url: normalized.installHint.url }));
      hint.appendChild(text);
      hint.appendChild(link);
      elements.infoContent.appendChild(hint);
    }
  }

  function renderInfoRow(key, value) {
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
      return row;
  }

  function normalizeInfo(info) {
    if (Array.isArray(info?.sections)) return info;
    return {
      mediaType: 'image',
      source: 'Built-in',
      sections: [
        {
          title: 'Image',
          rows: [
            { label: 'width', value: info?.width },
            { label: 'height', value: info?.height },
            { label: 'color Space', value: info?.colorSpace },
            { label: 'chroma subsampling', value: info?.chromaSubsampling },
            { label: 'bit depth', value: info?.bitDepth },
            { label: 'compression mode', value: info?.compressionMode },
            { label: 'stream size', value: info?.streamSize },
            { label: 'file size', value: info?.fileSize },
            { label: 'format', value: info?.format },
            { label: 'abs path', value: info?.absPath }
          ]
        }
      ]
    };
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
    state.mediaType = 'all';
    state.format = 'all';
    updateFilterOptions();
    resetRender();
  });

  elements.project.addEventListener('change', () => {
    state.projectName = elements.project.value;
    state.moduleName = 'all';
    state.mediaType = 'all';
    state.format = 'all';
    updateFilterOptions();
    resetRender();
  });

  elements.module.addEventListener('change', () => {
    state.moduleName = elements.module.value;
    state.mediaType = 'all';
    state.format = 'all';
    updateFilterOptions();
    resetRender();
  });

  elements.mediaType.addEventListener('change', () => {
    state.mediaType = elements.mediaType.value;
    state.format = 'all';
    updateFilterOptions();
    resetRender();
  });

  elements.format.addEventListener('change', () => {
    state.format = elements.format.value;
    updateFilterOptions();
    resetRender();
  });

  elements.zoomOut.addEventListener('click', () => {
    setTileSize(state.tileSize - TILE_SIZE_STEP);
  });

  elements.zoomIn.addEventListener('click', () => {
    setTileSize(state.tileSize + TILE_SIZE_STEP);
  });

  elements.zoomReset.addEventListener('click', () => {
    setTileSize(DEFAULT_TILE_SIZE);
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
        if (item.mediaInfo || item.imageInfo) {
          state.infoByPath.set(item.absPath, item.mediaInfo || item.imageInfo);
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

  applyTileSize();
  setLoading(true, 'Indexing assets...');
  post('ready');
})();
