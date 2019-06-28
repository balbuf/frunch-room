const tableName = 'keyValue';

module.exports = class keyValueStore {

  /**
   * Construct a new keyValueStore object.
   * @param {sqlite3.Database} db
   */
  constructor(db) {
    // create a promise that resolves when the required table is ready to go
    const dbPromise = new Promise((resolve, reject) => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (
        key TEXT PRIMARY KEY,
        value BLOB
      )`, (err) => {
        err ? reject(err) : resolve(db);
      });
    });
    this.db = () => {
      return dbPromise;
    };
  }

  /**
   * Get the corresponding value of the given key.
   * @param {string} key
   */
  async get(key) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      db.get(`SELECT value FROM ${tableName} WHERE key = ?`, key, (err, data) => {
        err ? reject(err) : resolve(data && data.value);
      });
    });
  }

  /**
   * Set the corresponding value of the given key.
   * @param {string} key
   * @param {*} value
   */
  async set(key, value) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO ${tableName}(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      , key, value, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }

}
