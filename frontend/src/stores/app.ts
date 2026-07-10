/**
 * Application State Store
 * Maintains global UI state covering sidebar, loading indicators, and toast notifications
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Toast, ToastType, PublicSettings } from '@/types'
import { i18n } from '@/i18n'
import {
  checkUpdates as checkUpdatesAPI,
  type VersionInfo,
  type ReleaseInfo
} from '@/api/admin/system'
import { getPublicSettings as fetchPublicSettingsAPI } from '@/api/auth'

export const useAppStore = defineStore('app', () => {
  // ==================== State ====================

  const sidebarCollapsed = ref<boolean>(false)
  const mobileOpen = ref<boolean>(false)
  const sidebarScrollTop = ref<number>(0)
  const loading = ref<boolean>(false)
  const toasts = ref<Toast[]>([])

  // Public settings cache state
  const publicSettingsLoaded = ref<boolean>(false)
  const publicSettingsLoading = ref<boolean>(false)
  const siteName = ref<string>('Sub2API')
  const siteLogo = ref<string>('')
  const siteVersion = ref<string>('')
  const contactInfo = ref<string>('')
  const apiBaseUrl = ref<string>('')
  const docUrl = ref<string>('')
  const cachedPublicSettings = ref<PublicSettings | null>(null)
  let publicSettingsRequest: Promise<PublicSettings | null> | null = null

  // Version cache variables
  const versionLoaded = ref<boolean>(false)
  const versionLoading = ref<boolean>(false)
  const currentVersion = ref<string>('')
  const latestVersion = ref<string>('')
  const hasUpdate = ref<boolean>(false)
  const buildType = ref<string>('source')
  const releaseInfo = ref<ReleaseInfo | null>(null)

  // Self-incrementing counter used for toast identifiers
  let toastIdCounter = 0

  // ==================== Computed ====================

  const hasActiveToasts = computed(() => toasts.value.length > 0)
  const backendModeEnabled = computed(() => cachedPublicSettings.value?.backend_mode_enabled ?? false)

  const loadingCount = ref<number>(0)

  // ==================== Actions ====================

  /**
   * Toggle the sidebar between collapsed and expanded
   */
  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  /**
   * Explicitly set whether the sidebar is collapsed
   * @param collapsed - Whether the sidebar ought to be collapsed
   */
  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed.value = collapsed
  }

  /**
   * Toggle the mobile sidebar open/closed
   */
  function toggleMobileSidebar(): void {
    mobileOpen.value = !mobileOpen.value
  }

  /**
   * Explicitly set whether the mobile sidebar is open
   * @param open - Whether the mobile sidebar should stay open
   */
  function setMobileOpen(open: boolean): void {
    mobileOpen.value = open
  }

  /**
   * Toggle the global loading indicator
   * @param isLoading - Whether the app is currently in a loading state
   */
  function setLoading(isLoading: boolean): void {
    if (isLoading) {
      loadingCount.value++
    } else {
      loadingCount.value = Math.max(0, loadingCount.value - 1)
    }
    loading.value = loadingCount.value > 0
  }

  /**
   * Display a toast notification
   * @param type - Toast category (success, error, info, warning)
   * @param message - Text content shown in the toast
   * @param duration - Auto-dismiss timeout in ms (undefined means no auto-dismiss)
   * @returns Toast ID that can be used for manual dismissal
   */
  function showToast(type: ToastType, message: string, duration?: number): string {
    const id = `toast-${++toastIdCounter}`
    const toast: Toast = {
      id,
      type,
      message,
      duration,
      startTime: duration !== undefined ? Date.now() : undefined
    }

    toasts.value.push(toast)

    // Auto-dismiss when a duration is provided
    if (duration !== undefined) {
      setTimeout(() => {
        hideToast(id)
      }, duration)
    }

    return id
  }

  /**
   * Display a success toast
   * @param message - Success text
   * @param duration - Auto-dismiss timeout in ms (default: 3000)
   */
  function showSuccess(message: string, duration: number = 3000): string {
    return showToast('success', message, duration)
  }

  /**
   * Display an error toast
   * @param message - Error text
   * @param duration - Auto-dismiss timeout in ms (default: 5000)
   */
  function showError(message: string, duration: number = 5000): string {
    return showToast('error', message, duration)
  }

  /**
   * Display an info toast
   * @param message - Info text
   * @param duration - Auto-dismiss timeout in ms (default: 3000)
   */
  function showInfo(message: string, duration: number = 3000): string {
    return showToast('info', message, duration)
  }

  /**
   * Display a warning toast
   * @param message - Warning text
   * @param duration - Auto-dismiss timeout in ms (default: 4000)
   */
  function showWarning(message: string, duration: number = 4000): string {
    return showToast('warning', message, duration)
  }

  /**
   * Dismiss a particular toast by its ID
   * @param id - Toast identifier to remove
   */
  function hideToast(id: string): void {
    const index = toasts.value.findIndex((t) => t.id === id)
    if (index !== -1) {
      toasts.value.splice(index, 1)
    }
  }

  /**
   * Remove every toast currently displayed
   */
  function clearAllToasts(): void {
    toasts.value = []
  }

  /**
   * Run an async task while toggling the loading indicator
   * The loading flag is managed automatically
   * @param operation - Async function that will be executed
   * @returns Promise that resolves with the operation's result
   */
  async function withLoading<T>(operation: () => Promise<T>): Promise<T> {
    setLoading(true)
    try {
      return await operation()
    } finally {
      setLoading(false)
    }
  }

  /**
   * Run an async task with loading indicator and error handling
   * Surfaces an error toast when the operation fails
   * @param operation - Async function that will be executed
   * @param errorMessage - Custom error text (optional)
   * @returns Promise that resolves with the result, or null when an error occurs
   */
  async function withLoadingAndError<T>(
    operation: () => Promise<T>,
    errorMessage?: string
  ): Promise<T | null> {
    setLoading(true)
    try {
      return await operation()
    } catch (error) {
      const message =
        errorMessage ||
        (error as { message?: string }).message ||
        i18n.global.t('common.unknownError')
      showError(message)
      return null
    } finally {
      setLoading(false)
    }
  }

  /**
   * Restore app state back to its defaults
   * Handy for teardown or testing scenarios
   */
  function reset(): void {
    sidebarCollapsed.value = false
    loading.value = false
    loadingCount.value = 0
    toasts.value = []
  }

  // ==================== Version Management ====================

  /**
   * Retrieve version information (served from cache unless force=true)
   * @param force - When true, bypass the cache and pull fresh data from the API
   */
  async function fetchVersion(force = false): Promise<VersionInfo | null> {
    // Serve cached data when available and a refresh is not being forced
    if (versionLoaded.value && !force) {
      return {
        current_version: currentVersion.value,
        latest_version: latestVersion.value,
        has_update: hasUpdate.value,
        build_type: buildType.value,
        release_info: releaseInfo.value || undefined,
        cached: true
      }
    }

    // Avoid sending the same request twice
    if (versionLoading.value) {
      return null
    }

    versionLoading.value = true
    try {
      const data = await checkUpdatesAPI(force)
      currentVersion.value = data.current_version
      latestVersion.value = data.latest_version
      hasUpdate.value = data.has_update
      buildType.value = data.build_type || 'source'
      releaseInfo.value = data.release_info || null
      versionLoaded.value = true
      return data
    } catch (error) {
      console.error('Failed to fetch version:', error)
      return null
    } finally {
      versionLoading.value = false
    }
  }

  /**
   * Invalidate the version cache (e.g., once an update is done)
   */
  function clearVersionCache(): void {
    versionLoaded.value = false
    hasUpdate.value = false
  }

  // ==================== Public Settings Management ====================

  /**
   * Populate store state with the given settings (internal helper that prevents duplicated logic)
   */
  function applySettings(config: PublicSettings): void {
    if (typeof window !== 'undefined') {
      window.__APP_CONFIG__ = { ...config }
    }
    cachedPublicSettings.value = config
    siteName.value = config.site_name || 'Sub2API'
    siteLogo.value = config.site_logo || ''
    siteVersion.value = config.version || ''
    contactInfo.value = config.contact_info || ''
    apiBaseUrl.value = config.api_base_url || ''
    docUrl.value = config.doc_url || ''
    publicSettingsLoaded.value = true
  }

  /**
   * Retrieve public settings (served from cache unless force=true)
   * @param force - When true, bypass the cache and fetch fresh data from the API
   */
  function fetchPublicSettings(force = false): Promise<PublicSettings | null> {
    // An in-flight request always takes precedence over cache/force semantics so that
    // every caller receives the same refresh result and a stale request cannot overwrite a newer one.
    if (publicSettingsRequest) {
      return publicSettingsRequest
    }

    // Pick up server-injected config if present (prevents a flash of stale content)
    if (!publicSettingsLoaded.value && !force && window.__APP_CONFIG__) {
      applySettings(window.__APP_CONFIG__)
      return Promise.resolve(window.__APP_CONFIG__)
    }

    // Serve cached data when available and a refresh is not being forced
    if (publicSettingsLoaded.value && !force) {
      if (cachedPublicSettings.value) {
        return Promise.resolve({ ...cachedPublicSettings.value })
      }
      return Promise.resolve({
        registration_enabled: false,
        email_verify_enabled: false,
        force_email_on_third_party_signup: false,
        registration_email_suffix_whitelist: [],
        promo_code_enabled: true,
        password_reset_enabled: false,
        invitation_code_enabled: false,
        turnstile_enabled: false,
        turnstile_site_key: '',
        site_name: siteName.value,
        site_logo: siteLogo.value,
        site_subtitle: '',
        api_base_url: apiBaseUrl.value,
        contact_info: contactInfo.value,
        doc_url: docUrl.value,
        home_content: '',
        hide_ccs_import_button: false,
        payment_enabled: false,
        table_default_page_size: 20,
        table_page_size_options: [10, 20, 50, 100],
        custom_menu_items: [],
        custom_endpoints: [],
        linuxdo_oauth_enabled: false,
        wechat_oauth_enabled: false,
        wechat_oauth_open_enabled: false,
        wechat_oauth_mp_enabled: false,
        wechat_oauth_mobile_enabled: false,
        oidc_oauth_enabled: false,
        oidc_oauth_provider_name: 'OIDC',
        github_oauth_enabled: false,
        google_oauth_enabled: false,
        backend_mode_enabled: false,
        version: siteVersion.value,
        balance_low_notify_enabled: false,
        account_quota_notify_enabled: false,
        balance_low_notify_threshold: 0,
        channel_monitor_enabled: true,
        channel_monitor_default_interval_seconds: 60,
        available_channels_enabled: false,
        risk_control_enabled: false,
        service_quota_enabled: false,
        affiliate_enabled: false,
        allow_user_view_error_requests: false,
      })
    }

    publicSettingsLoading.value = true
    let apiRequest: Promise<PublicSettings>
    try {
      apiRequest = fetchPublicSettingsAPI()
    } catch (error) {
      console.error('Failed to fetch public settings:', error)
      publicSettingsLoading.value = false
      return Promise.resolve(null)
    }

    const request = apiRequest
      .then((data) => {
        applySettings(data)
        return data
      })
      .catch((error) => {
        console.error('Failed to fetch public settings:', error)
        return null
      })
      .finally(() => {
        if (publicSettingsRequest === request) {
          publicSettingsRequest = null
          publicSettingsLoading.value = false
        }
      })

    publicSettingsRequest = request
    return request
  }

  /**
   * Invalidate the public settings cache
   */
  function clearPublicSettingsCache(): void {
    publicSettingsLoaded.value = false
    cachedPublicSettings.value = null
  }

  /**
   * Seed settings from the injected config (window.__APP_CONFIG__)
   * Invoked synchronously before the Vue app mounts so no flash occurs
   * @returns true when the config was located and applied, false otherwise
   */
  function initFromInjectedConfig(): boolean {
    if (window.__APP_CONFIG__) {
      applySettings(window.__APP_CONFIG__)
      return true
    }
    return false
  }

  // ==================== Return Store API ====================

  return {
    // State
    sidebarCollapsed,
    mobileOpen,
    sidebarScrollTop,
    loading,
    toasts,

    // Public settings variables
    publicSettingsLoaded,
    siteName,
    siteLogo,
    siteVersion,
    contactInfo,
    apiBaseUrl,
    docUrl,
    cachedPublicSettings,

    // Version variables
    versionLoaded,
    versionLoading,
    currentVersion,
    latestVersion,
    hasUpdate,
    buildType,
    releaseInfo,

    // Computed
    hasActiveToasts,
    backendModeEnabled,

    // Actions
    toggleSidebar,
    setSidebarCollapsed,
    toggleMobileSidebar,
    setMobileOpen,
    setLoading,
    showToast,
    showSuccess,
    showError,
    showInfo,
    showWarning,
    hideToast,
    clearAllToasts,
    withLoading,
    withLoadingAndError,
    reset,

    // Version actions
    fetchVersion,
    clearVersionCache,

    // Public settings actions
    fetchPublicSettings,
    clearPublicSettingsCache,
    initFromInjectedConfig
  }
})
