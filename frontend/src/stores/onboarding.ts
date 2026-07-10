/**
 * Onboarding Store
 * Holds onboarding tour state along with its control methods
 */

import { defineStore } from 'pinia'
import { markRaw, ref, shallowRef } from 'vue'
import type { Driver } from 'driver.js'

type VoidCallback = () => void
type NextStepCallback = (delay?: number) => Promise<void>
type IsCurrentStepCallback = (selector: string) => boolean

export const useOnboardingStore = defineStore('onboarding', () => {
  const replayCallback = ref<VoidCallback | null>(null)
  const nextStepCallback = ref<NextStepCallback | null>(null)
  const isCurrentStepCallback = ref<IsCurrentStepCallback | null>(null)

  // 全局 driver 实例，在组件之间共享
  const driverInstance = shallowRef<Driver | null>(null)

  function setReplayCallback(callback: VoidCallback | null): void {
    replayCallback.value = callback
  }

  function setControlMethods(methods: {
    nextStep: NextStepCallback,
    isCurrentStep: IsCurrentStepCallback
  }): void {
    nextStepCallback.value = methods.nextStep
    isCurrentStepCallback.value = methods.isCurrentStep
  }

  function clearControlMethods(): void {
    nextStepCallback.value = null
    isCurrentStepCallback.value = null
  }

  function setDriverInstance(driver: Driver | null): void {
    driverInstance.value = driver ? markRaw(driver) : null
  }

  function getDriverInstance(): Driver | null {
    return driverInstance.value
  }

  function isDriverActive(): boolean {
    return driverInstance.value?.isActive?.() ?? false
  }

  function replay(): void {
    if (replayCallback.value) {
      replayCallback.value()
    }
  }

  /**
   * Step forward to the next tour step manually
   * @param delay Optional delay in ms (handy when you need to wait for animations)
   */
  async function nextStep(delay = 0): Promise<void> {
    if (nextStepCallback.value) {
      await nextStepCallback.value(delay)
    }
  }

  /**
   * Determine whether the tour is currently highlighting the given element
   */
  function isCurrentStep(selector: string): boolean {
    if (isCurrentStepCallback.value) {
      return isCurrentStepCallback.value(selector)
    }
    return false
  }

  return {
    setReplayCallback,
    setControlMethods,
    clearControlMethods,
    setDriverInstance,
    getDriverInstance,
    isDriverActive,
    replay,
    nextStep,
    isCurrentStep
  }
})
