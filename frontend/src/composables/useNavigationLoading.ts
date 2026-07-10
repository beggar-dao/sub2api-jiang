/**
 * 导航加载状态组合式函数
 * 负责管理路由切换期间的加载状态，并内置防闪烁机制
 */
import { ref, readonly, computed } from 'vue'

/**
 * 导航加载状态管理
 *
 * 功能：
 * 1. 路由切换期间展示加载状态
 * 2. 极速导航（< 100ms）时不显示加载指示器，避免闪烁
 * 3. 导航被取消时能够正确重置状态
 */
export function useNavigationLoading() {
  // 内部维护的加载状态
  const _isLoading = ref(false)

  // 导航起始时刻（供防闪烁计算使用）
  let navigationStartTime: number | null = null

  // 防闪烁所用的延迟计时器
  let showLoadingTimer: ReturnType<typeof setTimeout> | null = null

  // 是否需要展示加载指示器（已纳入防闪烁考量）
  const shouldShowLoading = ref(false)

  // 防闪烁的延迟时长（单位：毫秒）
  const ANTI_FLICKER_DELAY = 100

  /**
   * 清除计时器
   */
  const clearTimer = (): void => {
    if (showLoadingTimer !== null) {
      clearTimeout(showLoadingTimer)
      showLoadingTimer = null
    }
  }

  /**
   * 在导航开始时调用
   */
  const startNavigation = (): void => {
    navigationStartTime = Date.now()
    _isLoading.value = true

    // 延迟展示加载指示器，从而实现防闪烁效果
    clearTimer()
    showLoadingTimer = setTimeout(() => {
      if (_isLoading.value) {
        shouldShowLoading.value = true
      }
    }, ANTI_FLICKER_DELAY)
  }

  /**
   * 在导航结束时调用
   */
  const endNavigation = (): void => {
    clearTimer()
    _isLoading.value = false
    shouldShowLoading.value = false
    navigationStartTime = null
  }

  /**
   * 在导航被取消时调用（例如快速连续点击多个不同链接）
   */
  const cancelNavigation = (): void => {
    clearTimer()
    // 维持加载状态不变，因为新的导航即将立刻开始
    // 仅重置导航起始时刻
    navigationStartTime = null
  }

  /**
   * 重置全部状态（供测试使用）
   */
  const resetState = (): void => {
    clearTimer()
    _isLoading.value = false
    shouldShowLoading.value = false
    navigationStartTime = null
  }

  /**
   * 读取导航持续的时长（单位：毫秒）
   */
  const getNavigationDuration = (): number | null => {
    if (navigationStartTime === null) {
      return null
    }
    return Date.now() - navigationStartTime
  }

  // 对外暴露的加载状态（只读）
  const isLoading = computed(() => shouldShowLoading.value)

  // 内部加载状态（供测试使用，不经过防闪烁处理）
  const isNavigating = readonly(_isLoading)

  return {
    isLoading,
    isNavigating,
    startNavigation,
    endNavigation,
    cancelNavigation,
    resetState,
    getNavigationDuration,
    // 导出常量以供测试引用
    ANTI_FLICKER_DELAY
  }
}

// 构建单例实例，供全局调用
let navigationLoadingInstance: ReturnType<typeof useNavigationLoading> | null = null

export function useNavigationLoadingState() {
  if (!navigationLoadingInstance) {
    navigationLoadingInstance = useNavigationLoading()
  }
  return navigationLoadingInstance
}

// 导出重置函数（供测试使用）
export function _resetNavigationLoadingInstance(): void {
  if (navigationLoadingInstance) {
    navigationLoadingInstance.resetState()
  }
  navigationLoadingInstance = null
}
