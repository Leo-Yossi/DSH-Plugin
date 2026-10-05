/**
 * Browser half of `@local/dsh-context-inspector`.
 *
 * Registers two slot entries from one module:
 *
 * - `conversation.input.right` — the compact button in the composer tool row
 *   that opens the window, right beside Send.
 * - `shell.overlay` — the frame-wide window itself. It is a separate
 *   registration because `shell.overlay` is the frame-wide floating layer
 *   (above every column, outside their scroll containers), while the button
 *   lives in the Session-scoped composer.
 *
 * The two entries share one module-level snapshot store: the button is the only
 * place that can read the Session projection, so it publishes the value and the
 * overlay renders it. The store is a plain observable plus
 * `useSyncExternalStore` — no second renderer, no DOM written outside a
 * component, and no portal to `document.body`.
 *
 * Per the shipped `cordis-plugin-development` practices, this bundle imports no
 * Harness Client package: React comes from the browser module table, styles are
 * plain CSS built from `cordis_inspect_query Theme` tokens, and every control
 * is written here.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-context-inspector',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace; also the prefix for every CSS class below. */
    const NS = '@local/dsh-context-inspector'
    /** Projection key the Host half registers. */
    const PROJECTION_KEY = 'contextPayload'
    /** Composer tool row: "Compact controls before the composer submit action". */
    const BUTTON_SLOT = 'conversation.input.right'
    /** Frame-wide floating layer, above every column. */
    const PANEL_SLOT = 'shell.overlay'
    /** Inline strings longer than this start collapsed. */
    const LONG_STRING = 160
    /** Most hits the list renders at once; the count still reports the total. */
    const HIT_LIST_CAP = 200

    //#region shared panel store

    /**
     * The shared store holds the *projection value* — the whole wire view
     * (`{ payload, fields, omitted, records, hooks, marks, stats }`) — because
     * that is what `useProjection` yields. The payload the model receives is
     * `view.payload`; records reference it by JSON-pointer path, so resolving a
     * record always means walking `view.payload`, never the view.
     *
     * `owner` is the composer occurrence that opened the window. One Session can
     * be mounted more than once at a time — the main conversation and a
     * right-sidebar chat tab are separate occurrences — and each renders its own
     * button. Keying on the occurrence instead of the Session keeps those two
     * buttons from mirroring each other: only the one that was clicked shows as
     * open, and only it owns the window it opened.
     */
    let panelState = { open: false, owner: undefined, sessionId: undefined, view: undefined }
    const panelListeners = new Set()

    /** Monotonic id handed to each mounted button occurrence. */
    let buttonOccurrence = 0

    /**
     * A stable identity for one mounted button. Two occurrences of the same
     * Session resolve to two different ids, which is exactly what has to be told
     * apart.
     * @returns this occurrence's id.
     */
    function useOccurrenceKey() {
      const ref = useRef(null)
      if (ref.current === null) {
        buttonOccurrence += 1
        ref.current = 'occ' + String(buttonOccurrence)
      }
      return ref.current
    }

    /**
     * Whether one composer occurrence owns the open window. Extracted from the
     * component so the rule that two panes must not mirror each other is
     * testable without a DOM.
     * @param state - the shared store snapshot.
     * @param occurrence - the id of the occurrence asking.
     */
    function occurrenceOwns(state, occurrence) {
      return state.open === true && state.owner === occurrence
    }

    function publish(patch) {
      panelState = Object.assign({}, panelState, patch)
      for (const listener of Array.from(panelListeners)) listener()
    }

    function subscribePanel(listener) {
      panelListeners.add(listener)
      return () => {
        panelListeners.delete(listener)
      }
    }

    function getPanelState() {
      return panelState
    }

    function usePanelState() {
      return useSyncExternalStore(subscribePanel, getPanelState)
    }

    //#endregion

    //#region source classification

    /**
     * The one place a context source becomes visible. Adding a source later is
     * a single entry here (plus the Host emitting its id): an unknown id falls
     * back to `FALLBACK_ORIGIN`, so nothing breaks in between.
     *
     * `tone` is a CSS color expression; `sent` says whether the source
     * contributes fields to the outgoing payload or only describes harness
     * activity around it.
     */
    const ORIGINS = {
      envelope: {
        glyph: '▤',
        tone: 'var(--dsw-alias-brand-primary)',
        order: 10,
        sent: true,
      },
      messages: {
        glyph: '☰',
        tone: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-state-idle-primary))',
        order: 20,
        sent: true,
      },
      system: {
        glyph: '§',
        tone: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, var(--dsw-alias-state-success-primary))',
        order: 30,
        sent: true,
      },
      tools: {
        glyph: '⚙',
        tone: 'var(--dsw-alias-state-success-primary)',
        order: 40,
        sent: true,
      },
      'tool-call': {
        glyph: '▶',
        tone: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 60%, var(--dsw-alias-state-warn-primary))',
        order: 50,
        sent: true,
      },
      'tool-result': {
        glyph: '◀',
        tone: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-state-idle-primary))',
        order: 60,
        sent: true,
      },
      developer: {
        glyph: '✎',
        tone: 'var(--dsw-alias-label-secondary)',
        order: 70,
        sent: true,
      },
      user: {
        glyph: '☺',
        tone: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-state-warn-primary))',
        order: 80,
        sent: true,
      },
      injected: {
        glyph: '⊕',
        tone: 'var(--dsw-alias-state-warn-primary)',
        order: 90,
        sent: true,
      },
      assistant: {
        glyph: '✦',
        tone: 'var(--dsw-alias-label-primary)',
        order: 100,
        sent: true,
      },
      routing: {
        glyph: '⇄',
        tone: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-state-success-primary))',
        order: 110,
        sent: false,
      },
      hooks: {
        glyph: '⚓',
        tone: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, var(--dsw-alias-state-error-primary))',
        order: 120,
        sent: false,
      },
      lifecycle: {
        glyph: '◇',
        tone: 'var(--dsw-alias-state-idle-primary)',
        order: 130,
        sent: false,
      },
      other: {
        glyph: '●',
        tone: 'var(--dsw-alias-label-secondary)',
        order: 900,
        sent: true,
      },
    }

    /** Presentation used for a source id this build does not know. */
    const FALLBACK_ORIGIN = {
      glyph: '●',
      tone: 'var(--dsw-alias-label-secondary)',
      order: 1000,
      sent: true,
    }

    function originOf(id) {
      return Object.prototype.hasOwnProperty.call(ORIGINS, id) ? ORIGINS[id] : FALLBACK_ORIGIN
    }

    //#endregion

    //#region dictionaries

    const EN = {
      'entry.title': 'Sent context',
      'entry.aria': 'View the context sent to the model',

      'panel.title': 'Sent context',
      'panel.subtitle': 'The payload this Session hands to the model',
      'panel.close': 'Close',
      'panel.maximize': 'Maximize',
      'panel.restore': 'Restore size',
      'panel.resize': 'Drag to resize',

      'view.code': 'Code',
      'view.fields': 'Fields',
      'action.expandAll': 'Expand all',
      'action.collapseAll': 'Collapse all',
      'action.reset': 'Reset folds',

      'state.loading':
        'No contextPayload projection yet. This Session has not sent a request, or the Host half of the plugin is not mounted.',
      'state.empty': 'This Session has not sent a request yet.',
      'state.noProjection':
        'The contextPayload projection is unavailable. Is the Host half of this plugin mounted?',

      'section.fields': 'Payload fields',
      'section.sources': 'Sent, grouped by source',
      'section.harness': 'Harness-side (not sent to the model)',
      'section.omitted': 'Absent fields',

      'note.origin':
        'Reconstructed on the Host from the Session log: the canonical request/header snapshot, the surface messages, the tool history fold, and the request routing record.',
      'note.limits':
        'This is the logical payload handed to llm.stream(). Adapter-side projection (file references to text, images to text on text-only routes, tool-schema rewriting) and compaction or title sub-requests are not covered.',

      'origin.envelope': 'Request envelope',
      'origin.envelope.desc': 'provider, model and sampling values the loop spreads into the request',
      'origin.messages': 'Message list',
      'origin.messages.desc': 'the messages array as a whole',
      'origin.system': 'System prompt',
      'origin.system.desc': 'rendered prompt, sent as the first system-role message',
      'origin.tools': 'Tool schemas',
      'origin.tools.desc': 'tool declarations offered in this request',
      'origin.tool-call': 'Tool calls',
      'origin.tool-call.desc': 'calls the model issued, inside assistant messages',
      'origin.tool-result': 'Tool results',
      'origin.tool-result.desc': 'results returned to the model',
      'origin.developer': 'Developer messages',
      'origin.developer.desc': 'tool add and remove notices',
      'origin.user': 'User input',
      'origin.user.desc': 'prompts the person sent',
      'origin.injected': 'Injected context',
      'origin.injected.desc': 'context admitted as user-role messages',
      'origin.assistant': 'Assistant output',
      'origin.assistant.desc': 'what the model produced earlier',
      'origin.routing': 'Routing metadata',
      'origin.routing.desc': 'request/context: route, context window, prompt-update mode',
      'origin.hooks': 'Hooks',
      'origin.hooks.desc': 'hook invocations and decisions recorded around the turn',
      'origin.lifecycle': 'Lifecycle markers',
      'origin.lifecycle.desc': 'turn, step and compaction boundaries',
      'origin.other': 'Unclassified',
      'origin.other.desc': 'records this build does not classify',

      'kind.request-header': 'request/header',
      'kind.tool-schema': 'tool schema',
      'kind.request-context': 'request/context',
      'kind.system-prompt': 'system message',
      'kind.developer-message': 'developer message',
      'kind.user-message': 'user message',
      'kind.injected-context': 'injected context',
      'kind.assistant-message': 'assistant message',
      'kind.tool-result': 'tool result',
      'kind.tool-call': 'tool call',
      'kind.hook-invoked': 'hook invoked',
      'kind.hook-result': 'hook result',
      'kind.marker': 'marker',

      'omitted.system-travels-in-messages':
        'absent: the loop leaves GenerateOptions.system undefined and sends the prompt as messages[0]',
      'omitted.agent-loop-requests-only':
        'absent: only compaction and title sub-requests carry a purpose',

      'stat.messages': 'messages',
      'stat.tools': 'tools',
      'stat.hooks': 'hooks',
      'stat.chars': 'system prompt chars',
      'stat.bytes': 'payload bytes',
      'stat.records': 'records',

      'search.placeholder': 'Search this context',
      'search.prev': 'Previous match',
      'search.next': 'Next match',
      'search.clear': 'Clear search',
      'search.none': 'No matches',
      'search.results': 'matches',
      'search.more': '… more matches not listed',
      'search.entry.value': 'value',
      'search.entry.object': 'object',
      'search.entry.field': 'field',
      'search.entry.record': 'record',
    }

    const ZH = {
      'entry.title': '已发送上下文',
      'entry.aria': '查看发送给模型的上下文',

      'panel.title': '已发送上下文',
      'panel.subtitle': '本会话交给模型的完整 payload',
      'panel.close': '关闭',
      'panel.maximize': '最大化',
      'panel.restore': '还原大小',
      'panel.resize': '拖动可缩放',

      'view.code': '代码视图',
      'view.fields': '字段视图',
      'action.expandAll': '全部展开',
      'action.collapseAll': '全部折叠',
      'action.reset': '重置折叠',

      'state.loading': '还没有 contextPayload 投影：本会话尚未发出请求，或插件的 Host 半边未挂载。',
      'state.empty': '本会话还没有发出请求。',
      'state.noProjection': '拿不到 contextPayload 投影，插件的 Host 半边是否已挂载？',

      'section.fields': 'Payload 字段',
      'section.sources': '实际发送，按来源分组',
      'section.harness': 'Harness 侧（不发送给模型）',
      'section.omitted': '缺失字段',

      'note.origin':
        '在 Host 侧由会话日志重建：规范 request/header 快照、surface 消息、工具历史折叠与请求路由记录。',
      'note.limits':
        '这是交给 llm.stream() 的逻辑 payload。适配器侧投影（文件引用转文本、纯文本模型下图像转文本、工具 schema 重写）以及压缩／标题子请求不在此列。',

      'origin.envelope': '请求信封',
      'origin.envelope.desc': '循环展开进请求的 provider、model 与采样参数',
      'origin.messages': '消息列表',
      'origin.messages.desc': 'messages 数组整体',
      'origin.system': '系统提示词',
      'origin.system.desc': '渲染后的提示词，作为第一条 system 消息发送',
      'origin.tools': '工具 schema',
      'origin.tools.desc': '本次请求提供的工具声明',
      'origin.tool-call': '工具调用',
      'origin.tool-call.desc': '模型发起的调用，位于 assistant 消息内',
      'origin.tool-result': '工具结果',
      'origin.tool-result.desc': '回传给模型的结果',
      'origin.developer': 'Developer 消息',
      'origin.developer.desc': '工具增删通知',
      'origin.user': '用户输入',
      'origin.user.desc': '用户发送的提示',
      'origin.injected': '注入上下文',
      'origin.injected.desc': '以 user 角色准入的上下文',
      'origin.assistant': '助手输出',
      'origin.assistant.desc': '模型此前产生的内容',
      'origin.routing': '路由元数据',
      'origin.routing.desc': 'request/context：路由、上下文窗口、提示词更新模式',
      'origin.hooks': 'Hook',
      'origin.hooks.desc': '轮次前后记录的 hook 调用与决策',
      'origin.lifecycle': '生命周期标记',
      'origin.lifecycle.desc': 'turn、step 与压缩边界',
      'origin.other': '未分类',
      'origin.other.desc': '本版本未归类的记录',

      'kind.request-header': 'request/header',
      'kind.tool-schema': '工具 schema',
      'kind.request-context': 'request/context',
      'kind.system-prompt': 'system 消息',
      'kind.developer-message': 'developer 消息',
      'kind.user-message': 'user 消息',
      'kind.injected-context': '注入上下文',
      'kind.assistant-message': 'assistant 消息',
      'kind.tool-result': '工具结果',
      'kind.tool-call': '工具调用',
      'kind.hook-invoked': 'hook 调用',
      'kind.hook-result': 'hook 结果',
      'kind.marker': '标记',

      'omitted.system-travels-in-messages':
        '缺失：循环不设置 GenerateOptions.system，提示词作为 messages[0] 发送',
      'omitted.agent-loop-requests-only': '缺失：仅压缩与标题子请求带 purpose',

      'stat.messages': '消息',
      'stat.tools': '工具',
      'stat.hooks': 'hook',
      'stat.chars': '系统提示词字符',
      'stat.bytes': 'payload 字节',
      'stat.records': '记录',

      'search.placeholder': '在此上下文中搜索',
      'search.prev': '上一处',
      'search.next': '下一处',
      'search.clear': '清空搜索',
      'search.none': '没有匹配',
      'search.results': '处匹配',
      'search.more': '… 还有更多匹配未列出',
      'search.entry.value': '值',
      'search.entry.object': '对象',
      'search.entry.field': '字段',
      'search.entry.record': '记录',
    }

    //#endregion

    //#region styles

    /**
     * Every color comes from a `Theme.listTokens` token; spacing, radii and
     * type sizes are literal geometry. Per-source color rides an inline
     * `--ci-tone` custom property, which is how the host UI itself passes
     * dynamic values into a stylesheet.
     *
     * This is a **floating window, not a modal**: there is deliberately no
     * backdrop, so the app underneath keeps every click — `shell.overlay` is a
     * click-through layer and this entry opts back into pointer events only for
     * its own box. Its position and size come from the clamped frame in JS, and
     * the top clamp is what keeps it clear of the in-page Windows title bar and
     * its window controls.
     */
    const CSS = [
      '.ci-win{position:fixed;z-index:2147483000;pointer-events:auto;display:flex;',
      'flex-direction:column;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;',
      'box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);',
      'font-size:13px;line-height:20px}',
      '.ci-win:focus{outline:none}',
      '.ci-head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;cursor:move;',
      'user-select:none;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ci-head-main{flex:1;min-width:0}',
      '.ci-title{font-size:14px;font-weight:600}',
      '.ci-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:2px}',
      '.ci-resize{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize}',
      '.ci-resize::after{content:"";position:absolute;right:4px;bottom:4px;width:9px;height:9px;',
      'border-right:2px solid var(--dsw-alias-border-l2);border-bottom:2px solid var(--dsw-alias-border-l2);',
      'border-radius:0 0 5px 0}',
      '.ci-resize:hover::after{border-color:var(--dsw-alias-brand-primary)}',
      '.ci-close{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);',
      'border-radius:6px;width:28px;height:28px;font-size:16px;line-height:1;flex:none}',
      '.ci-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.ci-bar{display:flex;align-items:center;gap:8px;padding:8px 16px;flex-wrap:wrap;',
      'border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ci-tabs{display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2);padding:2px;border-radius:8px}',
      '.ci-tab{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:12px;padding:4px 12px;border-radius:6px}',
      '.ci-tab[data-on="1"]{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-weight:500}',
      '.ci-act{cursor:pointer;border:.5px solid var(--dsw-alias-border-l1);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 10px;border-radius:6px}',
      '.ci-act:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.ci-stats{margin-left:auto;display:flex;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.ci-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 24px}',
      '.ci-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;',
      'border-left:2px solid var(--dsw-alias-border-l2);padding:2px 0 2px 10px;margin:4px 0 14px}',
      '.ci-empty{color:var(--dsw-alias-label-secondary);padding:40px 0;text-align:center}',
      '.ci-sect{margin:18px 0 8px}',
      '.ci-sect-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;',
      'color:var(--dsw-alias-label-secondary);text-transform:none}',
      '.ci-group{margin:10px 0 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}',
      '.ci-group-head{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;',
      'background:color-mix(in srgb,var(--ci-tone) 10%,transparent);border-left:3px solid var(--ci-tone)}',
      '.ci-group-head:hover{background:color-mix(in srgb,var(--ci-tone) 16%,transparent)}',
      '.ci-group-glyph{color:var(--ci-tone);font-size:13px;width:16px;text-align:center;flex:none}',
      '.ci-group-name{font-weight:600;color:var(--ci-tone)}',
      '.ci-group-count{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.ci-group-desc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-left:auto;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}',
      '.ci-group-body{padding:4px 8px 8px}',
      '.ci-rec{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.ci-rec:first-child{border-top:none}',
      '.ci-row{display:flex;align-items:baseline;gap:6px;padding:3px 4px;border-radius:6px;min-width:0}',
      '.ci-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ci-chev{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:10px;width:14px;flex:none;padding:0;text-align:center}',
      '.ci-chev-sp{width:14px;flex:none}',
      '.ci-badge{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;',
      'color:var(--ci-tone);background:color-mix(in srgb,var(--ci-tone) 12%,transparent);',
      'border:.5px solid color-mix(in srgb,var(--ci-tone) 35%,transparent);border-radius:5px;padding:0 6px}',
      '.ci-kind{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.ci-label{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;min-width:0}',
      '.ci-note-inline{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}',
      '.ci-key{color:var(--dsw-alias-label-secondary)}',
      '.ci-num{color:var(--dsw-alias-state-success-primary)}',
      '.ci-str{color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.ci-bool{color:var(--dsw-alias-state-warn-primary)}',
      '.ci-null{color:var(--dsw-alias-state-idle-primary)}',
      '.ci-sum{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.ci-pre{margin:2px 0 6px 20px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);',
      'border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;white-space:pre-wrap;',
      'word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:12px;line-height:18px;max-height:420px;overflow:auto}',
      '.ci-rec-body{padding:2px 0 8px 20px}',
      '.ci-field{display:grid;grid-template-columns:210px 116px 1fr;gap:8px;align-items:baseline;',
      'padding:4px 4px;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.ci-field:first-child{border-top:none}',
      '.ci-field-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.ci-field-val{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;font-size:12px}',
      '.ci-field[data-absent="1"] .ci-field-name,.ci-field[data-absent="1"] .ci-field-val{',
      'color:var(--dsw-alias-state-idle-primary)}',
      '.ci-btn{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;',
      'justify-content:center;border:none;border-radius:6px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary)}',
      '.ci-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.ci-btn[data-on="1"]{color:var(--dsw-alias-brand-primary)}',
      '.ci-btn:focus-visible,.ci-act:focus-visible,.ci-tab:focus-visible,.ci-close:focus-visible',
      '{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      // Find bar and hit list.
      '.ci-find{display:flex;align-items:center;gap:6px;padding:7px 16px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ci-find-input{flex:1;min-width:0;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;padding:4px 8px;outline:none}',
      '.ci-find-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ci-find-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.ci-count{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:62px;',
      'text-align:right;font-variant-numeric:tabular-nums;flex:none}',
      '.ci-hits{max-height:170px;overflow:auto;border-bottom:.5px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.ci-hit{display:flex;align-items:baseline;gap:8px;padding:3px 16px;cursor:pointer;font-size:12px}',
      '.ci-hit:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ci-hit[data-cur="1"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
      '.ci-hit-path{color:var(--dsw-alias-label-secondary);flex:none;max-width:44%;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.ci-hit-preview{color:var(--dsw-alias-label-secondary);overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.ci-hit-more{padding:3px 16px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      // Highlights: every run the query matched, and a stronger run inside the
      // current hit so a jump is visible even where the row is already on screen.
      'mark.ci-mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);',
      'color:var(--dsw-alias-label-primary);border-radius:2px;padding:0 1px}',
      '[data-ci-cur="1"] mark.ci-mark{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}',
      '.ci-row[data-ci-cur="1"],.ci-field[data-ci-cur="1"]{',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);',
      'box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
    ].join('')

    //#endregion

    //#region helpers

    function tOf(t, key) {
      return typeof t === 'function' ? t(key) : key
    }

    /** Walk a JSON-pointer-ish path (`/messages/0/content/1`) into the payload. */
    function getAtPath(root, path) {
      if (typeof path !== 'string' || path === '' || path === '/') return root
      let cursor = root
      for (const raw of path.split('/')) {
        if (raw === '') continue
        if (cursor === null || cursor === undefined) return undefined
        cursor = cursor[raw]
      }
      return cursor
    }

    const PX = (depth) => String(depth * 14) + 'px'

    function literalType(value) {
      if (value === null) return 'null'
      if (typeof value === 'number') return 'num'
      if (typeof value === 'boolean') return 'bool'
      return 'str'
    }

    function literalText(value) {
      if (value === null) return 'null'
      if (typeof value === 'string') return JSON.stringify(value)
      return String(value)
    }

    /** One-line summary for a value of any shape. */
    function summarize(value, max) {
      const cap = max === undefined ? 120 : max
      if (value === undefined) return '—'
      if (value === null) return 'null'
      if (Array.isArray(value)) return `[${String(value.length)}]`
      if (typeof value === 'object') return `{${String(Object.keys(value).length)}}`
      const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value)
      return text.length > cap ? text.slice(0, cap) + '…' : text
    }

    /** Count the rendered size of a record body, capped, to pick a default fold. */
    function bodySize(value) {
      if (value === undefined || value === null) return 0
      if (typeof value === 'string') return value.length
      if (Array.isArray(value)) return value.length === 0 ? 0 : 2000
      if (typeof value === 'object') {
        const keys = Object.keys(value)
        if (keys.length === 0) return 0
        let total = 0
        for (const key of keys) {
          const inner = value[key]
          if (typeof inner === 'string') total += inner.length
          else if (Array.isArray(inner)) total += inner.length === 0 ? 0 : 2000
          else if (inner !== null && typeof inner === 'object') total += 2000
          if (total > 2000) return 2000
        }
        return total
      }
      return 0
    }

    //#endregion

    //#region search

    /**
     * Case-insensitive literal match. Deliberately substring rather than a
     * regular expression: the payload is full of `(`, `[`, `\` and `*`, and a
     * half-typed pattern must never throw while someone is searching.
     */
    function matchText(haystack, query) {
      if (query === '' || query === undefined || query === null) return false
      if (haystack === undefined || haystack === null) return false
      return String(haystack).toLowerCase().indexOf(String(query).toLowerCase()) !== -1
    }

    /**
     * Split one rendered string into plain runs and matched runs.
     *
     * Both the index and the markup call `matchText`, so what is found is
     * exactly what is highlighted.
     * @param text - the rendered string.
     * @param query - the search text.
     * @returns the original string when nothing matches, else React children.
     */
    function highlightText(text, query) {
      const source = String(text)
      if (query === '' || query === undefined || query === null) return source
      const needle = String(query).toLowerCase()
      const lowered = source.toLowerCase()
      if (needle.length === 0 || lowered.indexOf(needle) === -1) return source
      const parts = []
      let cursor = 0
      let at = lowered.indexOf(needle, cursor)
      let key = 0
      while (at !== -1) {
        if (at > cursor) parts.push(source.slice(cursor, at))
        parts.push(
          h(
            'mark',
            { className: 'ci-mark', key: 'h' + String(key++) },
            source.slice(at, at + needle.length),
          ),
        )
        cursor = at + needle.length
        at = lowered.indexOf(needle, cursor)
      }
      if (cursor < source.length) parts.push(source.slice(cursor))
      return parts
    }

    /**
     * The strings one leaf renders. A long string renders twice — a quoted
     * summary in its tree row and the raw body in its `<pre>` — so both are
     * searchable.
     */
    function leafTexts(value) {
      if (typeof value === 'string') return [JSON.stringify(value), value]
      if (value === null) return ['null']
      return [String(value)]
    }

    /** Whether a leaf renders through the expandable long-string row. */
    function isLongText(value) {
      return typeof value === 'string' && (value.length > LONG_STRING || value.indexOf('\n') !== -1)
    }

    /**
     * The fold id a value at `base + path` is rendered under. A long string's
     * row is its own fold node, hence the `#text` suffix.
     */
    function anchorId(base, value, path) {
      return base + path + (isLongText(value) ? '#text' : '')
    }

    /**
     * Walk a value in the exact order the tree renders it and collect one hit
     * per node whose name or rendered text matches.
     *
     * The walk is over the *data*, not the DOM, which is precisely what lets a
     * match inside a collapsed node be located: the hit carries the ancestor
     * chain (`openIds`) that has to be forced open before scrolling to it.
     *
     * @param root - value to walk.
     * @param query - search text.
     * @param base - fold-id prefix this subtree renders under.
     * @param host - optional description of the container the subtree lives in.
     * @returns ordered hits `{ id, openIds, path, label, preview, kind, host }`.
     */
    function collectValueHits(root, query, base, host) {
      const hits = []
      const visit = (name, value, path, ancestors) => {
        const id = anchorId(base, value, path)
        const leaf = value === null || typeof value !== 'object'
        const texts = leaf ? [name].concat(leafTexts(value)) : [name]
        if (texts.some((text) => matchText(text, query))) {
          const hostLabel = host === undefined ? 'payload' : host.label
          hits.push({
            id,
            openIds: ancestors.concat([id]),
            path: base + path,
            label: name === '' ? hostLabel : name,
            preview: leaf
              ? summarize(value)
              : Array.isArray(value)
                ? '[' + String(value.length) + ']'
                : '{' + String(Object.keys(value).length) + '}',
            kind: leaf ? 'search.entry.value' : 'search.entry.object',
            host,
          })
        }
        if (leaf) return
        const entries = Array.isArray(value)
          ? value.map((item, index) => [String(index), item])
          : Object.entries(value)
        for (const [key, child] of entries) {
          visit(key, child, path + '/' + key, ancestors.concat([id]))
        }
      }
      visit('', root, '', [])
      return hits
    }

    /**
     * Search hits for the code view: the payload tree, plus the harness-side
     * tree the same view renders below it (which lives outside the payload).
     * @param payload - the outgoing request object.
     * @param query - search text.
     * @param harness - the `{ hooks, marks }` tree, omitted when that section is
     *   not rendered so a hit can never point at an anchor that does not exist.
     */
    function collectCodeHits(payload, query, harness) {
      if (payload === undefined || query === '' || query === undefined) return []
      const hits = collectValueHits(payload, query, '', undefined)
      if (harness !== undefined) {
        for (const hit of collectValueHits(harness, query, '/harness', { label: 'harness' })) {
          hits.push(hit)
        }
      }
      return hits
    }

    /**
     * Search hits for the field view, mirroring what it renders: the field
     * overview rows, the record rows, and every record body — a body being
     * either a payload subtree (resolved by `record.path`) or the record's own
     * `data`.
     */
    function collectFieldHits(view, payload, query, sessionId, t) {
      if (view === undefined || query === '' || query === undefined) return []
      const hits = []

      for (const field of view.fields ?? []) {
        const value = field.path === '/sessionId' ? sessionId : getAtPath(payload, field.path)
        const summary = field.count === undefined ? summarize(value, 160) : String(field.count)
        if (!matchText(field.name, query) && !matchText(summary, query)) continue
        hits.push({
          id: 'field-' + field.name,
          openIds: [],
          path: field.name,
          label: field.name,
          preview: summary,
          kind: 'search.entry.field',
          origin: field.origin,
        })
      }

      for (const record of view.records ?? []) {
        const value = record.path === undefined ? record.data : getAtPath(payload, record.path)
        const groupId = 'grp-' + record.origin
        const rowId = 'rec-' + record.id
        const kindLabel = tOf(t, 'kind.' + record.kind)
        const rowLabel = kindLabel + (record.label === undefined ? '' : ' · ' + record.label)
        const rowText = [kindLabel, record.label, record.note, record.path]
        if (rowText.some((text) => matchText(text, query))) {
          hits.push({
            id: rowId,
            openIds: [groupId],
            path: record.path ?? kindLabel,
            label: rowLabel,
            preview: summarize(value, 120),
            kind: 'search.entry.record',
            origin: record.origin,
          })
        }
        const bodyHits = collectValueHits(value, query, rowId, {
          label: rowLabel,
          origin: record.origin,
        })
        for (const hit of bodyHits) {
          // The body root shares the record row's id, and the row hit already
          // covers it, so keep the two from double-counting one match. The
          // chain already starts at the record row (`hit.openIds[0]`), so only
          // the group has to be prepended.
          if (hit.id === rowId) continue
          hits.push(
            Object.assign({}, hit, { openIds: [groupId].concat(hit.openIds), origin: record.origin }),
          )
        }
      }

      return hits
    }

    /** Escape a value for use inside a quoted attribute selector. */
    function attrEscape(value) {
      return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }

    //#endregion

    //#region fold state for the UI

    /**
     * Explicit per-node fold state plus a tri-state default, so "expand all"
     * and "collapse all" stay cheap while a manual click always wins.
     *
     * Search drives the same table through `reveal`, so a jump and a click
     * share one mechanism and one source of truth.
     */
    function useFolds() {
      const [explicit, setExplicit] = useState({})
      const [mode, setMode] = useState('auto')

      const isOpen = useCallback(
        (id, fallback) => {
          const value = explicit[id]
          if (value !== undefined) return value
          if (mode === 'all') return true
          if (mode === 'none') return false
          return fallback
        },
        [explicit, mode],
      )

      const toggle = useCallback((id, current) => {
        setExplicit((previous) => Object.assign({}, previous, { [id]: !current }))
      }, [])

      /**
       * Force an explicit open for every id. This is how a jump expands a
       * collapsed node: an explicit `true` outranks the `none` mode, so a
       * search still reveals its hit after "collapse all".
       * @param ids - fold ids to open, outermost first.
       */
      const reveal = useCallback((ids) => {
        if (ids.length === 0) return
        setExplicit((previous) => {
          const next = Object.assign({}, previous)
          let changed = false
          for (const id of ids) {
            if (next[id] === true) continue
            next[id] = true
            changed = true
          }
          return changed ? next : previous
        })
      }, [])

      const reset = useCallback(() => {
        setExplicit({})
        setMode('auto')
      }, [])

      return { isOpen, toggle, reveal, mode, setMode, reset }
    }

    //#endregion

    //#region JSON tree (code view and record bodies)

    function JsonNode(props) {
      const { name, value, path, depth, folds, find } = props

      if (value === null || typeof value !== 'object') {
        const isText = typeof value === 'string'
        if (isText && isLongText(value)) {
          const id = path + '#text'
          const open = folds.isOpen(id, false)
          return h(
            'div',
            null,
            h(
              'div',
              {
                className: 'ci-row',
                style: { paddingLeft: PX(depth) },
                'data-ci-id': id,
                'data-ci-cur': find.currentId === id ? '1' : undefined,
              },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ci-chev',
                  'aria-expanded': open,
                  onClick: () => folds.toggle(id, open),
                },
                open ? '▾' : '▸',
              ),
              h('span', { className: 'ci-key' }, highlightText(name, find.query)),
              h('span', { className: 'ci-key' }, ': '),
              h('span', { className: 'ci-str' }, highlightText(JSON.stringify(summarize(value)), find.query)),
              h('span', { className: 'ci-sum' }, ` (${String(value.length)} chars)`),
            ),
            open ? h('pre', { className: 'ci-pre' }, highlightText(value, find.query)) : null,
          )
        }
        return h(
          'div',
          {
            className: 'ci-row',
            style: { paddingLeft: PX(depth) },
            'data-ci-id': path,
            'data-ci-cur': find.currentId === path ? '1' : undefined,
          },
          h('span', { className: 'ci-chev-sp' }),
          h('span', { className: 'ci-key' }, highlightText(name, find.query)),
          h('span', { className: 'ci-key' }, ': '),
          h(
            'span',
            { className: 'ci-' + literalType(value) },
            highlightText(literalText(value), find.query),
          ),
        )
      }

      const isArray = Array.isArray(value)
      const size = isArray ? value.length : Object.keys(value).length
      const open = folds.isOpen(path, depth === 0)
      const summary = isArray ? `[${String(size)}]` : `{${String(size)}}`

      let children = null
      if (open && size > 0) {
        const entries = isArray
          ? value.map((item, index) => [String(index), item])
          : Object.entries(value)
        children = entries.map((entry) =>
          h(JsonNode, {
            key: path + '/' + entry[0],
            name: entry[0],
            value: entry[1],
            path: path + '/' + entry[0],
            depth: depth + 1,
            folds,
            find,
          }),
        )
      }

      return h(
        'div',
        null,
        h(
          'div',
          {
            className: 'ci-row',
            style: { paddingLeft: PX(depth) },
            'data-ci-id': path,
            'data-ci-cur': find.currentId === path ? '1' : undefined,
          },
          h(
            'button',
            {
              type: 'button',
              className: 'ci-chev',
              'aria-expanded': open,
              onClick: () => folds.toggle(path, open),
            },
            size === 0 ? '·' : open ? '▾' : '▸',
          ),
          h('span', { className: 'ci-key' }, highlightText(name, find.query)),
          h('span', { className: 'ci-sum' }, ` ${summary}`),
        ),
        children,
      )
    }

    //#endregion

    //#region source badge

    function OriginBadge(props) {
      const meta = originOf(props.origin)
      return h(
        'span',
        { className: 'ci-badge', style: { '--ci-tone': meta.tone } },
        h('span', null, meta.glyph),
        h('span', null, tOf(props.t, 'origin.' + props.origin)),
      )
    }

    //#endregion

    //#region field view

    function FieldOverview(props) {
      const { view, payload, t, find } = props
      const rows = view.fields.map((field) => {
        const value = field.path === '/sessionId' ? props.sessionId : getAtPath(payload, field.path)
        const absent = value === undefined
        const meta = originOf(field.origin)
        const text =
          field.count !== undefined && (field.name === 'tools' || field.name === 'toolHistory')
            ? `${String(field.count)}`
            : summarize(value, 160)
        const id = 'field-' + field.name
        return h(
          'div',
          {
            key: field.name,
            className: 'ci-field',
            'data-absent': absent ? '1' : '0',
            'data-ci-id': id,
            'data-ci-cur': find.currentId === id ? '1' : undefined,
            style: { '--ci-tone': meta.tone },
          },
          h('span', { className: 'ci-field-name' }, highlightText(field.name, find.query)),
          h(OriginBadge, { origin: field.origin, t }),
          h('span', { className: 'ci-field-val' }, absent ? '—' : highlightText(text, find.query)),
        )
      })

      const omitted = view.omitted.map((entry) =>
        h(
          'div',
          { key: 'omitted-' + entry.name, className: 'ci-field', 'data-absent': '1' },
          h('span', { className: 'ci-field-name' }, highlightText(entry.name, find.query)),
          h('span', { className: 'ci-kind' }, ''),
          h('span', { className: 'ci-field-val' }, tOf(t, 'omitted.' + entry.reason)),
        ),
      )

      return h(
        'div',
        null,
        h('div', { className: 'ci-sect' }, h('div', { className: 'ci-sect-head' }, tOf(t, 'section.fields'))),
        h('div', null, rows, omitted),
      )
    }

    function RecordNode(props) {
      const { record, payload, folds, sessionId, t, find } = props
      const value = record.path === undefined ? record.data : getAtPath(payload, record.path)
      const id = 'rec-' + record.id
      const short = bodySize(value) <= 200
      const open = folds.isOpen(id, short)
      const meta = originOf(record.origin)

      return h(
        'div',
        { className: 'ci-rec' },
        h(
          'div',
          {
            className: 'ci-row',
            style: { '--ci-tone': meta.tone },
            'data-ci-id': id,
            'data-ci-cur': find.currentId === id ? '1' : undefined,
          },
          h(
            'button',
            {
              type: 'button',
              className: 'ci-chev',
              'aria-expanded': open,
              onClick: () => folds.toggle(id, open),
            },
            open ? '▾' : '▸',
          ),
          h('span', { className: 'ci-kind' }, tOf(t, 'kind.' + record.kind)),
          h('span', { className: 'ci-label' }, highlightText(record.label ?? '', find.query)),
          record.note !== undefined
            ? h('span', { className: 'ci-note-inline' }, highlightText(record.note, find.query))
            : null,
          h('span', { className: 'ci-note-inline' }, `#${String(record.seq)}`),
        ),
        open
          ? h(
              'div',
              { className: 'ci-rec-body' },
              h(JsonNode, {
                name: record.path ?? record.kind,
                value,
                path: id,
                depth: 0,
                folds,
                find,
              }),
            )
          : null,
      )
    }

    function SourceGroups(props) {
      const { records, payload, folds, sessionId, t, find } = props

      const groups = useMemo(() => {
        const byOrigin = new Map()
        for (const record of records) {
          if (!byOrigin.has(record.origin)) byOrigin.set(record.origin, [])
          byOrigin.get(record.origin).push(record)
        }
        return Array.from(byOrigin.entries()).sort(
          (left, right) => originOf(left[0]).order - originOf(right[0]).order,
        )
      }, [records])

      return groups.map((entry) => {
        const origin = entry[0]
        const meta = originOf(origin)
        const id = 'grp-' + origin
        const open = folds.isOpen(id, true)
        return h(
          'div',
          { key: origin, className: 'ci-group', style: { '--ci-tone': meta.tone } },
          h(
            'div',
            {
              className: 'ci-group-head',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              'data-ci-id': id,
              onClick: () => folds.toggle(id, open),
              onKeyDown: (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                folds.toggle(id, open)
              },
            },
            h('span', null, open ? '▾' : '▸'),
            h('span', { className: 'ci-group-glyph' }, meta.glyph),
            h('span', { className: 'ci-group-name' }, tOf(t, 'origin.' + origin)),
            h('span', { className: 'ci-group-count' }, `${String(entry[1].length)}`),
            h('span', { className: 'ci-group-desc' }, tOf(t, 'origin.' + origin + '.desc')),
          ),
          open
            ? h(
                'div',
                { className: 'ci-group-body' },
                entry[1].map((record) =>
                  h(RecordNode, {
                    key: record.id,
                    record,
                    payload,
                    folds,
                    sessionId,
                    t,
                    find,
                  }),
                ),
              )
            : null,
        )
      })
    }

    //#endregion

    //#region floating window geometry

    /** Smallest the window may be resized to. */
    const MIN_WINDOW_WIDTH = 520
    const MIN_WINDOW_HEIGHT = 320
    /** Size the window opens at; shrunk to fit a small viewport. */
    const PREFERRED_WINDOW_WIDTH = 1100
    const PREFERRED_WINDOW_HEIGHT = 780
    /** Gap kept between the window and the edges it is clamped against. */
    const WINDOW_GAP = 12
    /** Extra space kept between the window's top edge and the title bar. */
    const WINDOW_TOP_GAP = 4

    /**
     * Height of the app's own title strip, measured rather than assumed. On
     * Windows the window controls live *in the page* at the top right
     * (`data-windows-titlebar`), so a floating panel that is allowed to rise
     * above them steals their clicks — the occlusion this window must not have.
     * @returns pixel height to stay below, or 0 when the shell has no such strip.
     */
    function titleBarInset() {
      if (typeof document === 'undefined') return 0
      let bottom = 0
      for (const strip of document.querySelectorAll('[data-window-drag]')) {
        bottom = Math.max(bottom, Math.round(strip.getBoundingClientRect().bottom))
      }
      if (bottom > 0) return bottom
      // A shell build that marks its Windows title bar but exposes no drag strip
      // to measure still gets a reserved row, rather than none: reserving too
      // much only costs a little space, reserving nothing puts the window back
      // on top of the window controls.
      if (document.documentElement.hasAttribute('data-windows-titlebar')) return 36
      return 0
    }

    /** The viewport size plus the strip the window must stay clear of. */
    function windowBounds() {
      return {
        width: typeof window === 'undefined' ? 1280 : window.innerWidth,
        height: typeof window === 'undefined' ? 800 : window.innerHeight,
        topInset: titleBarInset(),
      }
    }

    /**
     * Keep the window usable: at least `MIN_WINDOW_*`, no larger than the
     * viewport, never past the left/right edges, and **never above the title
     * bar** — that last constraint is what permanently keeps it off the window
     * controls, no matter where it is dragged or resized to.
     * @param frame - requested `{ x, y, width, height }`.
     * @param bounds - `{ width, height, topInset }`.
     * @returns a frame satisfying every constraint.
     */
    function clampFrame(frame, bounds) {
      const maxWidth = Math.max(MIN_WINDOW_WIDTH, bounds.width - WINDOW_GAP * 2)
      const maxHeight = Math.max(MIN_WINDOW_HEIGHT, bounds.height - bounds.topInset - WINDOW_GAP)
      const width = Math.min(Math.max(MIN_WINDOW_WIDTH, frame.width), maxWidth)
      const height = Math.min(Math.max(MIN_WINDOW_HEIGHT, frame.height), maxHeight)
      const minY = bounds.topInset + WINDOW_TOP_GAP
      return {
        width,
        height,
        x: Math.min(Math.max(WINDOW_GAP, frame.x), Math.max(WINDOW_GAP, bounds.width - width - WINDOW_GAP)),
        y: Math.min(Math.max(minY, frame.y), Math.max(minY, bounds.height - height - WINDOW_GAP)),
      }
    }

    /** The frame the window opens at: centred, and entirely below the title bar. */
    function initialFrame(bounds) {
      const width = Math.min(PREFERRED_WINDOW_WIDTH, bounds.width - WINDOW_GAP * 2)
      const height = Math.min(PREFERRED_WINDOW_HEIGHT, bounds.height - bounds.topInset - WINDOW_GAP * 2)
      const below = Math.max(0, bounds.height - bounds.topInset - height)
      return clampFrame(
        {
          x: Math.round((bounds.width - width) / 2),
          y: Math.round(bounds.topInset + Math.max(WINDOW_GAP, below / 2)),
          width,
          height,
        },
        bounds,
      )
    }

    /** The frame a maximized window takes: the viewport below the title bar. */
    function maximizedFrame(bounds) {
      return clampFrame(
        {
          x: WINDOW_GAP,
          y: bounds.topInset + WINDOW_TOP_GAP,
          width: bounds.width - WINDOW_GAP * 2,
          height: bounds.height - bounds.topInset - WINDOW_GAP * 2,
        },
        bounds,
      )
    }

    //#endregion

    //#region panel

    function InspectorPanel(props) {
      const { t } = props
      const state = usePanelState()
      const folds = useFolds()
      const [tab, setTab] = useState('fields')
      const panelRef = useRef(null)
      const restoreRef = useRef(null)

      //#region window frame

      /** `{ x, y, width, height }` in viewport pixels, or null while closed. */
      const [frame, setFrame] = useState(null)
      const [maximized, setMaximized] = useState(false)
      const restoreFrameRef = useRef(null)

      // The frame is re-derived from the live viewport, so a window that was
      // near an edge before a resize can never end up off-screen or over the
      // title bar.
      useEffect(() => {
        if (!state.open) {
          setFrame(null)
          setMaximized(false)
          return undefined
        }
        setFrame((current) => current ?? initialFrame(windowBounds()))
        const onResize = () => {
          setFrame((current) => (current === null ? current : clampFrame(current, windowBounds())))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [state.open])

      /**
       * Shared pointer drag: `apply` maps a pointer delta onto the live frame.
       * @param event - the pointerdown that starts the gesture.
       * @param apply - builds the requested frame from the origin frame and delta.
       */
      const startGesture = useCallback(
        (event, apply) => {
          if (event.button !== 0 || frame === null) return
          const origin = {
            x: event.clientX,
            y: event.clientY,
            frame,
            bounds: windowBounds(),
          }
          const move = (moveEvent) => {
            setFrame(
              clampFrame(
                apply(origin.frame, moveEvent.clientX - origin.x, moveEvent.clientY - origin.y),
                origin.bounds,
              ),
            )
          }
          const stop = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', stop)
            window.removeEventListener('pointercancel', stop)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', stop)
          window.addEventListener('pointercancel', stop)
          event.preventDefault()
        },
        [frame],
      )

      const onHeadPointerDown = useCallback(
        (event) => {
          // The header is the drag handle; its own buttons are not.
          if (event.target !== null && typeof event.target.closest === 'function' && event.target.closest('button') !== null) return
          startGesture(event, (origin, dx, dy) => ({
            x: origin.x + dx,
            y: origin.y + dy,
            width: origin.width,
            height: origin.height,
          }))
        },
        [startGesture],
      )

      const onResizePointerDown = useCallback(
        (event) => {
          startGesture(event, (origin, dx, dy) => ({
            x: origin.x,
            y: origin.y,
            width: origin.width + dx,
            height: origin.height + dy,
          }))
        },
        [startGesture],
      )

      const toggleMaximized = useCallback(() => {
        const bounds = windowBounds()
        if (maximized) {
          setFrame(clampFrame(restoreFrameRef.current ?? initialFrame(bounds), bounds))
          setMaximized(false)
          return
        }
        restoreFrameRef.current = frame
        setFrame(maximizedFrame(bounds))
        setMaximized(true)
      }, [frame, maximized])

      //#endregion

      const view = state.view
      const sessionId = state.sessionId
      /** The outgoing request object; `view` is the annotated wrapper around it. */
      const payload = view === undefined ? undefined : view.payload

      /** The payload as the loop builds it, with this Session's id filled in. */
      const displayPayload = useMemo(() => {
        if (payload === undefined) return undefined
        const copy = Object.assign({}, payload)
        if (copy.sessionId === null) copy.sessionId = sessionId
        return copy
      }, [payload, sessionId])

      //#region search state

      const [query, setQuery] = useState('')
      const [hitIndex, setHitIndex] = useState(0)
      /** `{ id, nonce }` — the nonce makes a repeat jump re-scroll to the same node. */
      const [focus, setFocus] = useState(undefined)
      const focusRef = useRef(0)

      /**
       * One index per view, built over the data rather than the DOM, so a match
       * inside a collapsed node is still found and can be revealed on jump.
       */
      const hits = useMemo(() => {
        if (view === undefined || payload === undefined) return []
        if (tab === 'code') {
          // The harness section renders only when it has records; indexing it
          // otherwise would aim hits at an anchor that is not in the DOM.
          const hasHarness = (view.records ?? []).some(
            (record) => !originOf(record.origin).sent,
          )
          return collectCodeHits(
            displayPayload,
            query,
            hasHarness ? { hooks: view.hooks, marks: view.marks } : undefined,
          )
        }
        return collectFieldHits(view, displayPayload, query, sessionId, t)
      }, [view, displayPayload, payload, query, tab, sessionId, t])

      const total = hits.length
      const current = total === 0 ? undefined : Math.min(hitIndex, total - 1)

      /** Jump to a hit: force its ancestors open, then scroll after the render. */
      const goTo = useCallback(
        (index, list) => {
          const items = list ?? hits
          if (items.length === 0) return
          const next = ((index % items.length) + items.length) % items.length
          setHitIndex(next)
          const hit = items[next]
          folds.reveal(hit.openIds)
          focusRef.current += 1
          setFocus({ id: hit.id, nonce: focusRef.current })
        },
        // `folds` is a fresh object every render; its `reveal` callback is not.
        // Depending on the callback keeps `goTo` stable, which the effect below
        // needs — otherwise every render would queue another jump.
        [hits, folds.reveal],
      )

      /**
       * A fresh query or a view switch re-anchors on the first hit, so typing
       * immediately lands somewhere instead of only listing matches. The token
       * guard makes this fire once per query, not on every later payload update
       * — new context arriving must not yank the reader away from a hit.
       */
      const autoJumpRef = useRef(null)
      useEffect(() => {
        const token = tab + '\u0000' + query
        if (autoJumpRef.current === token) return
        autoJumpRef.current = token
        setHitIndex(0)
        if (hits.length === 0) {
          setFocus(undefined)
          return
        }
        goTo(0, hits)
      }, [query, tab, hits, goTo])

      // The reveal above must render first: only then does the anchor exist.
      useEffect(() => {
        if (focus === undefined) return
        const node = document.querySelector('[data-ci-id="' + attrEscape(focus.id) + '"]')
        if (node === null) return
        node.scrollIntoView({ block: 'center' })
      }, [focus])

      const find = useMemo(
        () => ({
          query,
          currentId: current === undefined ? undefined : hits[current].id,
        }),
        [query, current, hits],
      )

      /** The Escape handler lives on `document`, so it must not close over a stale query. */
      const queryRef = useRef('')
      queryRef.current = query

      //#endregion

      useEffect(() => {
        if (!state.open) return undefined
        restoreRef.current = document.activeElement
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          // The window is not modal, so it only answers Escape while it holds
          // focus: an Escape aimed at the composer or a running turn must reach
          // the app untouched.
          const panel = panelRef.current
          if (panel === null || !panel.contains(document.activeElement)) return
          event.preventDefault()
          event.stopPropagation()
          // Escape inside a non-empty search box clears it; only an Escape with
          // nothing to clear closes the window.
          const target = event.target
          const inSearch =
            target !== null &&
            typeof target.getAttribute === 'function' &&
            target.getAttribute('data-ci-search') === '1'
          if (inSearch && queryRef.current !== '') {
            setQuery('')
            return
          }
          publish({ open: false })
        }
        document.addEventListener('keydown', onKeyDown, true)
        if (panelRef.current !== null) panelRef.current.focus()
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          const previous = restoreRef.current
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [state.open])

      const close = useCallback(() => publish({ open: false }), [])

      if (!state.open) return h('style', null, CSS)

      const sent = []
      const harness = []
      for (const record of view === undefined || view.records === undefined ? [] : view.records) {
        if (originOf(record.origin).sent) sent.push(record)
        else harness.push(record)
      }

      const stats = view === undefined ? undefined : view.stats

      const body =
        view === undefined || payload === undefined
          ? h('div', { className: 'ci-empty' }, tOf(t, 'state.loading'))
          : view.assembled !== true
            ? h('div', { className: 'ci-empty' }, tOf(t, 'state.empty'))
            : h(
                'div',
                null,
                h('div', { className: 'ci-note' }, tOf(t, 'note.origin')),
                h('div', { className: 'ci-note' }, tOf(t, 'note.limits')),
                tab === 'code'
                  ? h(
                      'div',
                      null,
                      h(
                        'div',
                        { className: 'ci-sect' },
                        h('div', { className: 'ci-sect-head' }, tOf(t, 'section.fields')),
                      ),
                      h(JsonNode, {
                        name: 'payload',
                        value: displayPayload,
                        path: '',
                        depth: 0,
                        folds,
                        find,
                      }),
                      harness.length === 0
                        ? null
                        : h(
                            'div',
                            null,
                            h(
                              'div',
                              { className: 'ci-sect' },
                              h('div', { className: 'ci-sect-head' }, tOf(t, 'section.harness')),
                            ),
                            h(
                              'div',
                              { className: 'ci-notes' },
                              h(JsonNode, {
                                name: 'harness',
                                value: { hooks: view.hooks, marks: view.marks },
                                path: '/harness',
                                depth: 0,
                                folds,
                                find,
                              }),
                            ),
                          ),
                    )
                  : h(
                      'div',
                      null,
                      h(FieldOverview, { view, payload: displayPayload, sessionId, t, find }),
                      h(
                        'div',
                        { className: 'ci-sect' },
                        h('div', { className: 'ci-sect-head' }, tOf(t, 'section.sources')),
                      ),
                      h(SourceGroups, {
                        records: sent,
                        payload: displayPayload,
                        folds,
                        sessionId,
                        t,
                        find,
                      }),
                      harness.length === 0
                        ? null
                        : h(
                            'div',
                            null,
                            h(
                              'div',
                              { className: 'ci-sect' },
                              h('div', { className: 'ci-sect-head' }, tOf(t, 'section.harness')),
                            ),
                            h(SourceGroups, {
                              records: harness,
                              payload: displayPayload,
                              folds,
                              sessionId,
                              t,
                              find,
                            }),
                          ),
                    ),
              )

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          // A floating window, not a modal: no backdrop at all, so the app
          // underneath keeps every click. Its top edge is clamped below the
          // title bar in every gesture, which is what keeps it off the window
          // controls, and it drags by the header and resizes by the corner.
          'div',
          {
            className: 'ci-win',
            role: 'dialog',
            'aria-modal': 'false',
            'aria-label': tOf(t, 'panel.title'),
            tabIndex: -1,
            ref: panelRef,
            style: frame === null ? { visibility: 'hidden' } : {
              left: String(frame.x) + 'px',
              top: String(frame.y) + 'px',
              width: String(frame.width) + 'px',
              height: String(frame.height) + 'px',
            },
            onMouseDown: (event) => {
              // Clicking the body focuses the window so Escape reaches it, but
              // never steals focus from a control the click was aimed at.
              const target = event.target
              const interactive =
                target !== null &&
                typeof target.closest === 'function' &&
                target.closest('input,textarea,select,button,a,[role="button"]') !== null
              if (!interactive && panelRef.current !== null) panelRef.current.focus()
            },
          },
          h(
            'div',
            { className: 'ci-head', onPointerDown: onHeadPointerDown },
            h(
              'div',
              { className: 'ci-head-main' },
              h('div', { className: 'ci-title' }, tOf(t, 'panel.title')),
              h('div', { className: 'ci-sub' }, tOf(t, 'panel.subtitle')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ci-close',
                'aria-label': maximized
                  ? tOf(t, 'panel.restore')
                  : tOf(t, 'panel.maximize'),
                title: maximized ? tOf(t, 'panel.restore') : tOf(t, 'panel.maximize'),
                onClick: toggleMaximized,
              },
              maximized ? '❐' : '⤢',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ci-close',
                'aria-label': tOf(t, 'panel.close'),
                title: tOf(t, 'panel.close'),
                onClick: close,
              },
              '✕',
            ),
          ),
          h(
              'div',
              { className: 'ci-bar' },
              h(
                'div',
                { className: 'ci-tabs', role: 'tablist' },
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'ci-tab',
                    'data-on': tab === 'fields' ? '1' : '0',
                    'aria-selected': tab === 'fields',
                    onClick: () => setTab('fields'),
                  },
                  tOf(t, 'view.fields'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    role: 'tab',
                    className: 'ci-tab',
                    'data-on': tab === 'code' ? '1' : '0',
                    'aria-selected': tab === 'code',
                    onClick: () => setTab('code'),
                  },
                  tOf(t, 'view.code'),
                ),
              ),
              h(
                'button',
                { type: 'button', className: 'ci-act', onClick: () => folds.setMode('all') },
                tOf(t, 'action.expandAll'),
              ),
              h(
                'button',
                { type: 'button', className: 'ci-act', onClick: () => folds.setMode('none') },
                tOf(t, 'action.collapseAll'),
              ),
              h(
                'button',
                { type: 'button', className: 'ci-act', onClick: folds.reset },
                tOf(t, 'action.reset'),
              ),
              stats === undefined
                ? null
                : h(
                    'div',
                    { className: 'ci-stats' },
                    h('span', null, `${String(stats.messages)} ${tOf(t, 'stat.messages')}`),
                    h('span', null, `${String(stats.tools)} ${tOf(t, 'stat.tools')}`),
                    h('span', null, `${String(stats.hooks)} ${tOf(t, 'stat.hooks')}`),
                    h('span', null, `${String(stats.records ?? view.records.length)} ${tOf(t, 'stat.records')}`),
                    h('span', null, `${String(stats.payloadBytes)} ${tOf(t, 'stat.bytes')}`),
                  ),
            ),
            h(
              'div',
              { className: 'ci-find' },
              h('input', {
                type: 'search',
                className: 'ci-find-input',
                value: query,
                placeholder: tOf(t, 'search.placeholder'),
                'aria-label': tOf(t, 'search.placeholder'),
                'data-ci-search': '1',
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  // Enter walks the hits; Shift+Enter walks back, like an IDE.
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  goTo(current === undefined ? 0 : current + (event.shiftKey ? -1 : 1))
                },
              }),
              h(
                'span',
                { className: 'ci-count' },
                query === ''
                  ? ''
                  : total === 0
                    ? tOf(t, 'search.none')
                    : `${String((current ?? 0) + 1)} / ${String(total)}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ci-act',
                  title: tOf(t, 'search.prev'),
                  disabled: total === 0,
                  onClick: () => goTo(current === undefined ? 0 : current - 1),
                },
                '↑',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ci-act',
                  title: tOf(t, 'search.next'),
                  disabled: total === 0,
                  onClick: () => goTo(current === undefined ? 0 : current + 1),
                },
                '↓',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ci-act',
                  title: tOf(t, 'search.clear'),
                  disabled: query === '',
                  onClick: () => setQuery(''),
                },
                '✕',
              ),
            ),
            query !== '' && total > 0
              ? h(
                  'div',
                  { className: 'ci-hits' },
                  hits.slice(0, HIT_LIST_CAP).map((hit, index) =>
                    h(
                      'div',
                      {
                        key: hit.id + ':' + hit.path,
                        className: 'ci-hit',
                        'data-cur': index === current ? '1' : undefined,
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => goTo(index),
                        onKeyDown: (event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          goTo(index)
                        },
                      },
                      hit.origin === undefined
                        ? null
                        : h(OriginBadge, { origin: hit.origin, t }),
                      h('span', { className: 'ci-hit-path' }, highlightText(hit.path, query)),
                      h('span', { className: 'ci-kind' }, tOf(t, hit.kind)),
                      h('span', { className: 'ci-hit-preview' }, highlightText(hit.preview, query)),
                    ),
                  ),
                  total > HIT_LIST_CAP
                    ? h('div', { className: 'ci-hit-more' }, tOf(t, 'search.more'))
                    : null,
                )
              : null,
            h('div', { className: 'ci-body' }, body),
            h('div', {
              className: 'ci-resize',
              title: tOf(t, 'panel.resize'),
              'aria-hidden': true,
              onPointerDown: onResizePointerDown,
            }),
          ),
        )
    }

    //#endregion

    //#region entry button

    function InspectorIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 1.75, y: 3, width: 12.5, height: 10, rx: 1.6 }),
        h('path', { d: 'M4.5 6.25h7M4.5 8.5h7M4.5 10.75h4' }),
      )
    }

    function InspectorButton(props) {
      const { t, sessionId, useProjection } = props
      const state = usePanelState()
      const occurrence = useOccurrenceKey()
      const view = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      const known = typeof useProjection === 'function'
      // This occurrence owns the window only when it is the one that opened it,
      // so a second composer showing the same Session never looks or behaves
      // like the button that was actually clicked.
      const open = occurrenceOwns(state, occurrence)

      // The button is the only registration that can read the Session
      // projection, so it keeps the shared store current while the window is up.
      useEffect(() => {
        const current = getPanelState()
        if (!current.open || current.owner !== occurrence) return
        if (current.view === view && current.sessionId === sessionId) return
        publish({ view, sessionId })
      }, [view, sessionId, occurrence])

      // Losing this composer closes the window, but only the window this
      // occurrence opened: an unrelated pane unmounting must not close it.
      useEffect(
        () => () => {
          const current = getPanelState()
          if (current.owner !== occurrence) return
          publish({ open: false, owner: undefined, sessionId: undefined, view: undefined })
        },
        [occurrence],
      )

      const onClick = useCallback(() => {
        const current = getPanelState()
        if (current.open && current.owner === occurrence) {
          publish({ open: false })
          return
        }
        publish({ open: true, owner: occurrence, sessionId, view })
      }, [view, sessionId, occurrence])

      const label = tOf(t, 'entry.title')
      const disabled = !known

      return h(
        'button',
        {
          type: 'button',
          className: 'ci-btn',
          'data-on': open ? '1' : '0',
          title: label,
          'aria-label': label,
          'aria-expanded': open,
          disabled,
          onClick,
        },
        h(InspectorIcon, null),
      )
    }

    //#endregion

    //#region plugin

    /** Client services this bundle uses. */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), NS + ': dictionaries')

      ctx.slots.inject(BUTTON_SLOT, () =>
        ctx.slots.register(
          {
            name: BUTTON_SLOT,
            id: 'context-inspector-button',
            order: 30,
            locale: NS,
          },
          InspectorButton,
        ),
      )

      ctx.slots.inject(PANEL_SLOT, () =>
        ctx.slots.register(
          {
            name: PANEL_SLOT,
            id: 'context-inspector-panel',
            order: 40,
            locale: NS,
          },
          InspectorPanel,
        ),
      )
    }

    /**
     * Pure search helpers, exported so the offline smoke test can exercise the
     * index without a DOM. Cordis reads only `apply`, `inject`, `name` and
     * `Config` from a plugin object, so extra exports are inert — the same
     * convention `dsh-web-app` uses for its own `internals`.
     */
    const internals = {
      matchText,
      highlightText,
      collectValueHits,
      collectCodeHits,
      collectFieldHits,
      attrEscape,
      occurrenceOwns,
      clampFrame,
      initialFrame,
      maximizedFrame,
    }

    return { inject, apply, internals }

    //#endregion
  },
})
