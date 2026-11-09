import { nextTick, onActivated, watch, type Ref } from 'vue'

/**
 * A kept-alive page leaves the document while another shows, and loses its scroll
 * position. This puts it back, so going back lands where you were. Same when the
 * element itself is replaced and comes back, as Home's shelves do after a search.
 */
export function useKeptScroll(element: Ref<HTMLElement | undefined>) {
  let top = 0
  const onScroll = () => (top = element.value?.scrollTop ?? 0)
  watch(
    element,
    (current) => {
      if (current) current.scrollTop = top
    },
    { flush: 'post' },
  )
  onActivated(async () => {
    await nextTick()
    if (element.value) element.value.scrollTop = top
  })
  const reset = () => {
    top = 0
    if (element.value) element.value.scrollTop = 0
  }
  return { onScroll, reset }
}
