import { ref } from 'vue'

export const TOAST_MS = 2600

/** The one message showing. A new one replaces it. */
export const toastMessage = ref('')

let timer: ReturnType<typeof setTimeout> | undefined

export function showToast(message: string) {
  toastMessage.value = message
  clearTimeout(timer)
  timer = setTimeout(() => (toastMessage.value = ''), TOAST_MS)
}
