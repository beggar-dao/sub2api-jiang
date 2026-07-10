let globalStableObjectKeySeed = 0

/**
 * 为对象实例产出稳定 key（依托 WeakMap，不会污染业务对象）
 */
export function createStableObjectKeyResolver<T extends object>(prefix = 'item') {
  const keyMap = new WeakMap<T, string>()

  return (item: T): string => {
    const cached = keyMap.get(item)
    if (cached) {
      return cached
    }

    const key = `${prefix}-${++globalStableObjectKeySeed}`
    keyMap.set(item, key)
    return key
  }
}
