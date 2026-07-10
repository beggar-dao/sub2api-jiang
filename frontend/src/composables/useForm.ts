import { ref } from 'vue'
import { useAppStore } from '@/stores/app'

interface UseFormOptions<T> {
  form: T
  submitFn: (data: T) => Promise<void>
  successMsg?: string
  errorMsg?: string
}

/**
 * 统一表单提交逻辑
 * 负责管理加载状态、异常捕获与消息通知
 */
export function useForm<T>(options: UseFormOptions<T>) {
  const { form, submitFn, successMsg, errorMsg } = options
  const loading = ref(false)
  const appStore = useAppStore()

  const submit = async () => {
    if (loading.value) return
    
    loading.value = true
    try {
      await submitFn(form)
      if (successMsg) {
        appStore.showSuccess(successMsg)
      }
    } catch (error: any) {
      const detail = error.response?.data?.detail || error.response?.data?.message || error.message
      appStore.showError(errorMsg || detail)
      // 继续向上抛出异常，以便组件能够执行局部处理（例如展示校验错误信息）
      throw error
    } finally {
      loading.value = false
    }
  }

  return {
    loading,
    submit
  }
}
