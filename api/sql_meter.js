/* The rows a Durable Object's SQL reads and writes, as the platform counts and bills them (every
 * index a row of its own): each cursor's rowsRead and rowsWritten, summed once the call that made it
 * is over. The account's plan counts rows written per day (Workers Free stops at 100,000; Workers
 * Paid bills them), so the store reports what each of its objects spent (the admin stats route, the
 * measured tests). Storage doubles without these counts add nothing. */
export function meteredStorage(storage) {
  const meter = { rowsRead: 0, rowsWritten: 0 };
  const open = [];
  const settle = () => {
    for (const cursor of open.splice(0)) {
      meter.rowsRead += Number(cursor && cursor.rowsRead) || 0;
      meter.rowsWritten += Number(cursor && cursor.rowsWritten) || 0;
    }
    return meter;
  };
  const metered = {
    sql: {
      exec(query, ...bindings) {
        const cursor = storage.sql.exec(query, ...bindings);
        open.push(cursor);
        return cursor;
      },
    },
    transactionSync: callback => storage.transactionSync(callback),
  };
  return { storage: metered, settle };
}
