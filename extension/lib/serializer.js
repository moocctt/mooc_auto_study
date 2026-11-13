function createSerializer() {
  let tail = Promise.resolve();
  return async function run(task) {
    const prev = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev.catch(() => void 0);
      return await task();
    } finally {
      release();
    }
  };
}
export {
  createSerializer
};
