/**
 * 路由预加载组合式函数
 * 利用浏览器空闲时段提前加载用户可能访问的下一个页面，从而改善导航体验
 *
 * 优化说明：
 * - 不采用静态 import() 映射表，以免增大入口文件体积
 * - 依托路由配置动态读取组件的 import 函数
 * - 仅在确有预加载需求时才真正执行
 */
import { ref, readonly } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'

/**
 * 组件导入函数的类型定义
 */
type ComponentImportFn = () => Promise<unknown>

/**
 * 预加载邻接表：声明每条路由需要提前加载哪些相邻路由
 * 仅保存路由路径，不保存 import 函数，以规避打包问题
 */
const PREFETCH_ADJACENCY: Record<string, string[]> = {
  // Admin routes - 提前加载访问频率最高的相邻页面
  '/admin/dashboard': ['/admin/accounts', '/admin/users'],
  '/admin/accounts': ['/admin/dashboard', '/admin/users'],
  '/admin/users': ['/admin/groups', '/admin/dashboard'],
  '/admin/groups': ['/admin/subscriptions', '/admin/users'],
  '/admin/subscriptions': ['/admin/groups', '/admin/redeem'],
  // User-facing routes
  '/dashboard': ['/keys', '/usage'],
  '/keys': ['/dashboard', '/usage'],
  '/usage': ['/keys', '/redeem'],
  '/redeem': ['/usage', '/profile'],
  '/profile': ['/dashboard', '/keys']
}

/**
 * requestIdleCallback 返回值的类型
 */
type IdleCallbackHandle = number | ReturnType<typeof setTimeout>

/**
 * requestIdleCallback 的兼容垫片（面向 Safari < 15）
 */
const scheduleIdleCallback = (
  callback: IdleRequestCallback,
  options?: IdleRequestOptions
): IdleCallbackHandle => {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(callback, options)
  }
  return setTimeout(() => {
    callback({ didTimeout: false, timeRemaining: () => 50 })
  }, 1000)
}

const cancelScheduledCallback = (handle: IdleCallbackHandle): void => {
  if (typeof window.cancelIdleCallback === 'function' && typeof handle === 'number') {
    window.cancelIdleCallback(handle)
  } else {
    clearTimeout(handle)
  }
}

/**
 * 路由预加载组合式函数
 *
 * @param router - Vue Router 实例，用于读取路由组件信息
 */
export function useRoutePrefetch(router?: Router) {
  // 当前处于等待状态的预加载任务句柄
  const pendingPrefetchHandle = ref<IdleCallbackHandle | null>(null)

  // 已完成预加载的路由清单
  const prefetchedRoutes = ref<Set<string>>(new Set())

  /**
   * 依据路由配置读取组件的 import 函数
   */
  const getComponentImporter = (path: string): ComponentImportFn | null => {
    if (!router) return null

    const routes = router.getRoutes()
    const route = routes.find((r) => r.path === path)

    if (route && route.components?.default) {
      const component = route.components.default
      // 判断是否为懒加载组件（即函数形式）
      if (typeof component === 'function') {
        return component as ComponentImportFn
      }
    }
    return null
  }

  /**
   * 读取当前路由所需预加载的相邻路由路径列表
   */
  const getPrefetchPaths = (route: RouteLocationNormalized): string[] => {
    return PREFETCH_ADJACENCY[route.path] || []
  }

  /**
   * 执行单个组件的预加载操作
   */
  const prefetchComponent = async (importFn: ComponentImportFn): Promise<void> => {
    try {
      await importFn()
    } catch (error) {
      // 预加载出错时静默处理
      if (import.meta.env.DEV) {
        console.debug('[Prefetch] Failed to prefetch component:', error)
      }
    }
  }

  /**
   * 取消处于等待状态的预加载任务
   */
  const cancelPendingPrefetch = (): void => {
    if (pendingPrefetchHandle.value !== null) {
      cancelScheduledCallback(pendingPrefetchHandle.value)
      pendingPrefetchHandle.value = null
    }
  }

  /**
   * 启动路由预加载流程
   */
  const triggerPrefetch = (route: RouteLocationNormalized): void => {
    cancelPendingPrefetch()

    const prefetchPaths = getPrefetchPaths(route)
    if (prefetchPaths.length === 0) return

    pendingPrefetchHandle.value = scheduleIdleCallback(
      () => {
        pendingPrefetchHandle.value = null

        const routePath = route.path
        if (prefetchedRoutes.value.has(routePath)) return

        // 收集需要预加载的组件 import 函数
        const importFns: ComponentImportFn[] = []
        for (const path of prefetchPaths) {
          const importFn = getComponentImporter(path)
          if (importFn) {
            importFns.push(importFn)
          }
        }

        if (importFns.length > 0) {
          Promise.all(importFns.map(prefetchComponent)).then(() => {
            prefetchedRoutes.value.add(routePath)
          })
        }
      },
      { timeout: 2000 }
    )
  }

  /**
   * 重置预加载相关状态
   */
  const resetPrefetchState = (): void => {
    cancelPendingPrefetch()
    prefetchedRoutes.value.clear()
  }

  /**
   * 判定当前是否属于管理员路由
   */
  const isAdminRoute = (path: string): boolean => {
    return path.startsWith('/admin')
  }

  /**
   * 读取预加载配置（向后兼容旧版 API）
   */
  const getPrefetchConfig = (route: RouteLocationNormalized): ComponentImportFn[] => {
    const paths = getPrefetchPaths(route)
    const importFns: ComponentImportFn[] = []
    for (const path of paths) {
      const importFn = getComponentImporter(path)
      if (importFn) importFns.push(importFn)
    }
    return importFns
  }

  return {
    prefetchedRoutes: readonly(prefetchedRoutes),
    triggerPrefetch,
    cancelPendingPrefetch,
    resetPrefetchState,
    _getPrefetchConfig: getPrefetchConfig,
    _isAdminRoute: isAdminRoute
  }
}

// 向后兼容旧测试用例的导出
export const _adminPrefetchMap = PREFETCH_ADJACENCY
export const _userPrefetchMap = PREFETCH_ADJACENCY
