/**
 * Pinia Stores Export
 * Single entry point that re-exports every store used across the app
 */

export { useAuthStore } from './auth'
export { useAppStore } from './app'
export { useAdminSettingsStore } from './adminSettings'
export { useSubscriptionStore } from './subscriptions'
export { useOnboardingStore } from './onboarding'
export { useAnnouncementStore } from './announcements'
export { usePaymentStore } from './payment'
export { useAdminComplianceStore } from './adminCompliance'

// Re-export types for convenience
export type { User, LoginRequest, RegisterRequest, AuthResponse } from '@/types'
export type { Toast, ToastType, AppState } from '@/types'
