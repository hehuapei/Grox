export function createSerialMutationQueue() {
  let tail = Promise.resolve();

  return function enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = tail.then(mutation, mutation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
