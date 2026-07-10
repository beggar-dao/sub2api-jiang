import { ref, onMounted, onUnmounted, type Ref } from 'vue'
import type { Virtualizer } from '@tanstack/vue-virtual'

/**
 * WeChat-like swipe/drag row selection for DataTable,
 * featuring a translucent marquee overlay that visualizes the selection rectangle.
 *
 * Capabilities:
 *  - Dragging initiates within non-text regions of the current table-page layout
 *  - Mouse wheel scrolling keeps extending the selection to newly visible rows
 *  - Automatic scrolling kicks in when the cursor approaches viewport boundaries
 *  - A 5-pixel drag threshold prevents unintended selection triggered by plain clicks
 *
 * Usage:
 *   const containerRef = ref<HTMLElement | null>(null)
 *   useSwipeSelect(containerRef, {
 *     isSelected: (id) => selIds.value.includes(id),
 *     select: (id) => { if (!selIds.value.includes(id)) selIds.value.push(id) },
 *     deselect: (id) => { selIds.value = selIds.value.filter(x => x !== id) },
 *   })
 *
 * Wrap <DataTable> with <div ref="containerRef">...</div>
 * Each DataTable row must carry a data-row-id attribute.
 */
export interface SwipeSelectAdapter {
  isSelected: (id: number) => boolean
  select: (id: number) => void
  deselect: (id: number) => void
  batchUpdate?: (updater: (draft: Set<number>) => void) => void
}

export interface SwipeSelectVirtualContext {
  /** Retrieve the virtualizer instance */
  getVirtualizer: () => Virtualizer<HTMLElement, Element> | null
  /** Retrieve the full sorted dataset */
  getSortedData: () => any[]
  /** Extract the row ID from a given data row */
  getRowId: (row: any, index: number) => number
}

export function useSwipeSelect(
  containerRef: Ref<HTMLElement | null>,
  adapter: SwipeSelectAdapter,
  virtualContext?: SwipeSelectVirtualContext
) {
  const isDragging = ref(false)

  let dragMode: 'select' | 'deselect' = 'select'
  let startRowIndex = -1
  let lastEndIndex = -1
  let startY = 0
  let lastMouseY = 0
  let pendingStartY = 0
  let initialSelectedSnapshot = new Map<number, boolean>()
  let cachedRows: HTMLElement[] = []
  let marqueeEl: HTMLDivElement | null = null
  let cachedScrollParent: HTMLElement | null = null

  const DRAG_THRESHOLD = 5
  const SCROLL_ZONE = 60
  const SCROLL_SPEED = 8

  function getActivationRoot(): HTMLElement | null {
    const container = containerRef.value
    if (!container) return null
    return container.closest('.table-page-layout') as HTMLElement | null || container
  }

  function getDataRows(): HTMLElement[] {
    const container = containerRef.value
    if (!container) return []
    return Array.from(container.querySelectorAll('tbody tr[data-row-id]'))
  }

  function getRowId(el: HTMLElement): number | null {
    const raw = el.getAttribute('data-row-id')
    if (raw === null) return null
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
  }

  /** Locate the row index nearest to a viewport Y coordinate via binary search. */
  function findRowIndexAtY(clientY: number): number {
    const len = cachedRows.length
    if (len === 0) return -1

    // Edge-case lookups for the first and last rows
    const firstRect = cachedRows[0].getBoundingClientRect()
    if (clientY < firstRect.top) return 0
    const lastRect = cachedRows[len - 1].getBoundingClientRect()
    if (clientY > lastRect.bottom) return len - 1

    // Binary search — rows follow vertical ordering
    let lo = 0, hi = len - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const rect = cachedRows[mid].getBoundingClientRect()
      if (clientY < rect.top) hi = mid - 1
      else if (clientY > rect.bottom) lo = mid + 1
      else return mid
    }
    // Falling in the gap between two rows — choose the nearer one
    if (hi < 0) return 0
    if (lo >= len) return len - 1
    const rHi = cachedRows[hi].getBoundingClientRect()
    const rLo = cachedRows[lo].getBoundingClientRect()
    return (clientY - rHi.bottom < rLo.top - clientY) ? hi : lo
  }

  /** Virtual mode: derive the row index from a Y coordinate backed by virtualizer data */
  function findRowIndexAtYVirtual(clientY: number): number {
    const virt = virtualContext!.getVirtualizer()
    if (!virt) return -1
    const scrollEl = virt.scrollElement
    if (!scrollEl) return -1

    const scrollRect = scrollEl.getBoundingClientRect()
    const thead = scrollEl.querySelector('thead')
    const theadHeight = thead ? thead.getBoundingClientRect().height : 0
    const contentY = clientY - scrollRect.top - theadHeight + scrollEl.scrollTop

    // Scan the already-rendered virtualItems first
    const items = virt.getVirtualItems()
    for (const item of items) {
      if (contentY >= item.start && contentY < item.end) return item.index
    }

    // Beyond the visible window — fall back to estimation
    const totalCount = virtualContext!.getSortedData().length
    if (totalCount === 0) return -1
    const est = virt.options.estimateSize(0)
    const guess = Math.floor(contentY / est)
    return Math.max(0, Math.min(totalCount - 1, guess))
  }

  // --- Block native text selection through selectstart (avoids mutating body styles) ---
  function onSelectStart(e: Event) { e.preventDefault() }

  // --- Marquee selection overlay ---
  function createMarquee() {
    removeMarquee() // safeguard: clear any leftover marquee element
    marqueeEl = document.createElement('div')
    const isDark = document.documentElement.classList.contains('dark')
    Object.assign(marqueeEl.style, {
      position: 'fixed',
      background: isDark ? 'rgba(96, 165, 250, 0.15)' : 'rgba(59, 130, 246, 0.12)',
      border: isDark ? '1.5px solid rgba(96, 165, 250, 0.5)' : '1.5px solid rgba(59, 130, 246, 0.4)',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '9999',
      transition: 'none',
    })
    document.body.appendChild(marqueeEl)
  }

  function updateMarquee(currentY: number) {
    if (!marqueeEl || !containerRef.value) return
    const containerRect = containerRef.value.getBoundingClientRect()
    const top = Math.min(startY, currentY)
    const bottom = Math.max(startY, currentY)
    marqueeEl.style.left = containerRect.left + 'px'
    marqueeEl.style.width = containerRect.width + 'px'
    marqueeEl.style.top = top + 'px'
    marqueeEl.style.height = (bottom - top) + 'px'
  }

  function removeMarquee() {
    if (marqueeEl) { marqueeEl.remove(); marqueeEl = null }
  }

  // --- Row selection handling ---
  function applyRange(endIndex: number) {
    if (startRowIndex < 0 || endIndex < 0) return
    const rangeMin = Math.min(startRowIndex, endIndex)
    const rangeMax = Math.max(startRowIndex, endIndex)
    const prevMin = lastEndIndex >= 0 ? Math.min(startRowIndex, lastEndIndex) : rangeMin
    const prevMax = lastEndIndex >= 0 ? Math.max(startRowIndex, lastEndIndex) : rangeMax
    const lo = Math.min(rangeMin, prevMin)
    const hi = Math.max(rangeMax, prevMax)

    if (adapter.batchUpdate) {
      adapter.batchUpdate((draft) => {
        for (let i = lo; i <= hi && i < cachedRows.length; i++) {
          const id = getRowId(cachedRows[i])
          if (id === null) continue
          const shouldBeSelected = (i >= rangeMin && i <= rangeMax)
            ? (dragMode === 'select')
            : (initialSelectedSnapshot.get(id) ?? false)
          if (shouldBeSelected) draft.add(id)
          else draft.delete(id)
        }
      })
    } else {
      for (let i = lo; i <= hi && i < cachedRows.length; i++) {
        const id = getRowId(cachedRows[i])
        if (id === null) continue
        if (i >= rangeMin && i <= rangeMax) {
          if (dragMode === 'select') adapter.select(id)
          else adapter.deselect(id)
        } else {
          const wasSelected = initialSelectedSnapshot.get(id) ?? false
          if (wasSelected) adapter.select(id)
          else adapter.deselect(id)
        }
      }
    }
    lastEndIndex = endIndex
  }

  /** Virtual mode: apply the selection range against the data array rather than DOM elements */
  function applyRangeVirtual(endIndex: number) {
    if (startRowIndex < 0 || endIndex < 0) return
    const rangeMin = Math.min(startRowIndex, endIndex)
    const rangeMax = Math.max(startRowIndex, endIndex)
    const prevMin = lastEndIndex >= 0 ? Math.min(startRowIndex, lastEndIndex) : rangeMin
    const prevMax = lastEndIndex >= 0 ? Math.max(startRowIndex, lastEndIndex) : rangeMax
    const lo = Math.min(rangeMin, prevMin)
    const hi = Math.max(rangeMax, prevMax)
    const data = virtualContext!.getSortedData()

    if (adapter.batchUpdate) {
      adapter.batchUpdate((draft) => {
        for (let i = lo; i <= hi && i < data.length; i++) {
          const id = virtualContext!.getRowId(data[i], i)
          const shouldBeSelected = (i >= rangeMin && i <= rangeMax)
            ? (dragMode === 'select')
            : (initialSelectedSnapshot.get(id) ?? false)
          if (shouldBeSelected) draft.add(id)
          else draft.delete(id)
        }
      })
    } else {
      for (let i = lo; i <= hi && i < data.length; i++) {
        const id = virtualContext!.getRowId(data[i], i)
        if (i >= rangeMin && i <= rangeMax) {
          if (dragMode === 'select') adapter.select(id)
          else adapter.deselect(id)
        } else {
          const wasSelected = initialSelectedSnapshot.get(id) ?? false
          if (wasSelected) adapter.select(id)
          else adapter.deselect(id)
        }
      }
    }
    lastEndIndex = endIndex
  }

  // --- Locate the scrollable ancestor ---
  function getScrollParent(el: HTMLElement): HTMLElement {
    let parent = el.parentElement
    while (parent && parent !== document.documentElement) {
      const { overflow, overflowY } = getComputedStyle(parent)
      if (/(auto|scroll)/.test(overflow + overflowY)) return parent
      parent = parent.parentElement
    }
    return document.documentElement
  }

  // --- Scrollbar hit testing ---
  /** Determine whether the click lands on a scrollbar belonging to the target or one of its ancestors. */
  function isOnScrollbar(e: MouseEvent): boolean {
    let el = e.target as HTMLElement | null
    while (el && el !== document.documentElement) {
      const hasVScroll = el.scrollHeight > el.clientHeight
      const hasHScroll = el.scrollWidth > el.clientWidth
      if (hasVScroll || hasHScroll) {
        const rect = el.getBoundingClientRect()
        // clientWidth/clientHeight skip the scrollbar area; offsetWidth/offsetHeight cover it fully
        if (hasVScroll && e.clientX > rect.left + el.clientWidth) return true
        if (hasHScroll && e.clientY > rect.top + el.clientHeight) return true
      }
      el = el.parentElement
    }
    // Scrollbar at the document level
    const docEl = document.documentElement
    if (e.clientX >= docEl.clientWidth || e.clientY >= docEl.clientHeight) return true
    return false
  }

  /**
   * When the mouse press originates on inner cell content instead of cell padding,
   * defer to the browser's built-in text selection so that text can still be copied as usual.
   */
  function shouldPreferNativeTextSelection(target: HTMLElement): boolean {
    const row = target.closest('tbody tr[data-row-id]')
    if (!row) return false

    const cell = target.closest('td, th')
    if (!cell) return false

    return target !== cell && !target.closest('[data-swipe-select-handle]')
  }

  function hasDirectTextContent(target: HTMLElement): boolean {
    return Array.from(target.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) > 0
    )
  }

  function shouldPreferNativeSelectionOutsideRows(target: HTMLElement): boolean {
    const activationRoot = getActivationRoot()
    if (!activationRoot) return false
    if (!activationRoot.contains(target)) return false
    if (target.closest('tbody tr[data-row-id]')) return false

    return hasDirectTextContent(target)
  }

  // =============================================
  // Phase 1: detect whether the drag threshold (5px) has been crossed
  // =============================================
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    if (!containerRef.value) return

    const target = e.target as HTMLElement
    const activationRoot = getActivationRoot()
    if (!activationRoot || !activationRoot.contains(target)) return

    // Ignore clicks that land on any scrollbar (inner containers as well as the document)
    if (isOnScrollbar(e)) return

    if (target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="combobox"], [role="dialog"]')) return
    if (shouldPreferNativeTextSelection(target)) return
    if (shouldPreferNativeSelectionOutsideRows(target)) return

    if (virtualContext) {
      // Virtual mode: verify data availability rather than inspecting DOM rows
      const data = virtualContext.getSortedData()
      if (data.length === 0) return
    } else {
      cachedRows = getDataRows()
      if (cachedRows.length === 0) return
    }

    pendingStartY = e.clientY
    // Block native text selection the moment the mouse is pressed,
    // even before the drag threshold is satisfied (Phase 1).
    // Otherwise the browser may begin selecting text while the
    // pointer travels within the 0–5px threshold window.
    document.addEventListener('selectstart', onSelectStart)
    document.addEventListener('mousemove', onThresholdMove)
    document.addEventListener('mouseup', onThresholdUp)
  }

  function onThresholdMove(e: MouseEvent) {
    if (Math.abs(e.clientY - pendingStartY) < DRAG_THRESHOLD) return
    // Threshold surpassed — kick off the real drag
    document.removeEventListener('mousemove', onThresholdMove)
    document.removeEventListener('mouseup', onThresholdUp)

    if (virtualContext) {
      beginDragVirtual(pendingStartY)
    } else {
      beginDrag(pendingStartY)
    }

    // Handle the movement event that surpassed the threshold
    lastMouseY = e.clientY
    updateMarquee(e.clientY)
    const findIdx = virtualContext ? findRowIndexAtYVirtual : findRowIndexAtY
    const apply = virtualContext ? applyRangeVirtual : applyRange
    const rowIdx = findIdx(e.clientY)
    if (rowIdx >= 0) apply(rowIdx)
    autoScroll(e)

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('wheel', onWheel, { passive: true })
  }

  function onThresholdUp() {
    document.removeEventListener('mousemove', onThresholdMove)
    document.removeEventListener('mouseup', onThresholdUp)
    // Phase 1 ended before the threshold was reached — detach the selectstart blocker
    document.removeEventListener('selectstart', onSelectStart)
    cachedRows = []
  }

  // ============================
  // Phase 2: the drag session itself
  // ============================
  function beginDrag(clientY: number) {
    startRowIndex = findRowIndexAtY(clientY)
    const startRowId = startRowIndex >= 0 ? getRowId(cachedRows[startRowIndex]) : null
    dragMode = (startRowId !== null && adapter.isSelected(startRowId)) ? 'deselect' : 'select'

    initialSelectedSnapshot = new Map()
    for (const row of cachedRows) {
      const id = getRowId(row)
      if (id !== null) initialSelectedSnapshot.set(id, adapter.isSelected(id))
    }

    isDragging.value = true
    startY = clientY
    lastMouseY = clientY
    lastEndIndex = -1
    cachedScrollParent = cachedRows.length > 0
      ? getScrollParent(cachedRows[0])
      : (containerRef.value ? getScrollParent(containerRef.value) : null)

    createMarquee()
    updateMarquee(clientY)
    applyRange(startRowIndex)
    // selectstart has been blocked since Phase 1 (onMouseDown).
    // Wipe any text selection the browser may have initiated
    // before the selectstart handler became active.
    window.getSelection()?.removeAllRanges()
  }

  /** Virtual mode: kick off the drag using the data array */
  function beginDragVirtual(clientY: number) {
    startRowIndex = findRowIndexAtYVirtual(clientY)
    const data = virtualContext!.getSortedData()
    const startRowId = startRowIndex >= 0 && startRowIndex < data.length
      ? virtualContext!.getRowId(data[startRowIndex], startRowIndex)
      : null
    dragMode = (startRowId !== null && adapter.isSelected(startRowId)) ? 'deselect' : 'select'

    // Construct a complete snapshot covering every data row
    initialSelectedSnapshot = new Map()
    for (let i = 0; i < data.length; i++) {
      const id = virtualContext!.getRowId(data[i], i)
      initialSelectedSnapshot.set(id, adapter.isSelected(id))
    }

    isDragging.value = true
    startY = clientY
    lastMouseY = clientY
    lastEndIndex = -1

    // In virtual mode the scroll parent is the virtualizer's own scroll element
    const virt = virtualContext!.getVirtualizer()
    cachedScrollParent = virt?.scrollElement ?? (containerRef.value ? getScrollParent(containerRef.value) : null)

    createMarquee()
    updateMarquee(clientY)
    applyRangeVirtual(startRowIndex)
    window.getSelection()?.removeAllRanges()
  }

  let moveRAF = 0

  function onMouseMove(e: MouseEvent) {
    if (!isDragging.value) return
    lastMouseY = e.clientY
    const findIdx = virtualContext ? findRowIndexAtYVirtual : findRowIndexAtY
    const apply = virtualContext ? applyRangeVirtual : applyRange
    cancelAnimationFrame(moveRAF)
    moveRAF = requestAnimationFrame(() => {
      updateMarquee(lastMouseY)
      const rowIdx = findIdx(lastMouseY)
      if (rowIdx >= 0 && rowIdx !== lastEndIndex) apply(rowIdx)
    })
    autoScroll(e)
  }

  function onWheel() {
    if (!isDragging.value) return
    const findIdx = virtualContext ? findRowIndexAtYVirtual : findRowIndexAtY
    const apply = virtualContext ? applyRangeVirtual : applyRange
    // After wheel scrolling the visible rows shift — re-evaluate the selection
    requestAnimationFrame(() => {
      if (!isDragging.value) return // safeguard: the drag might have finished before this frame fired
      const rowIdx = findIdx(lastMouseY)
      if (rowIdx >= 0) apply(rowIdx)
    })
  }

  function cleanupDrag() {
    isDragging.value = false
    startRowIndex = -1
    lastEndIndex = -1
    cachedRows = []
    initialSelectedSnapshot.clear()
    cachedScrollParent = null
    cancelAnimationFrame(moveRAF)
    stopAutoScroll()
    removeMarquee()
    document.removeEventListener('selectstart', onSelectStart)
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.removeEventListener('wheel', onWheel)
  }

  function onMouseUp() {
    cleanupDrag()
  }

  // Guard: tear everything down when the mouse leaves the window or the window loses focus mid-drag
  function onWindowBlur() {
    if (isDragging.value) cleanupDrag()
    // Also tear down the threshold phase (Phase 1)
    document.removeEventListener('mousemove', onThresholdMove)
    document.removeEventListener('mouseup', onThresholdUp)
    document.removeEventListener('selectstart', onSelectStart)
  }

  // --- Automatic scrolling engine ---
  let scrollRAF = 0

  function autoScroll(e: MouseEvent) {
    cancelAnimationFrame(scrollRAF)
    const scrollEl = cachedScrollParent
    if (!scrollEl) return

    let dy = 0
    if (scrollEl === document.documentElement) {
      if (e.clientY < SCROLL_ZONE) dy = -SCROLL_SPEED
      else if (e.clientY > window.innerHeight - SCROLL_ZONE) dy = SCROLL_SPEED
    } else {
      const rect = scrollEl.getBoundingClientRect()
      if (e.clientY < rect.top + SCROLL_ZONE) dy = -SCROLL_SPEED
      else if (e.clientY > rect.bottom - SCROLL_ZONE) dy = SCROLL_SPEED
    }

    if (dy !== 0) {
      const findIdx = virtualContext ? findRowIndexAtYVirtual : findRowIndexAtY
      const apply = virtualContext ? applyRangeVirtual : applyRange
      const step = () => {
        const prevScrollTop = scrollEl.scrollTop
        scrollEl.scrollTop += dy
        // Re-evaluate the selection only when the scroll position truly changed
        if (scrollEl.scrollTop !== prevScrollTop) {
          const rowIdx = findIdx(lastMouseY)
          if (rowIdx >= 0 && rowIdx !== lastEndIndex) apply(rowIdx)
        }
        scrollRAF = requestAnimationFrame(step)
      }
      scrollRAF = requestAnimationFrame(step)
    }
  }

  function stopAutoScroll() {
    cancelAnimationFrame(scrollRAF)
  }

  // --- Component lifecycle hooks ---
  onMounted(() => {
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('blur', onWindowBlur)
  })

  onUnmounted(() => {
    document.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('blur', onWindowBlur)
    // Tear down any drag state that is still in progress
    document.removeEventListener('mousemove', onThresholdMove)
    document.removeEventListener('mouseup', onThresholdUp)
    document.removeEventListener('selectstart', onSelectStart)
    cleanupDrag()
  })

  return { isDragging }
}
