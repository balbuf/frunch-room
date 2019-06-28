const {google} = require('googleapis');
const {auth} = require('google-auth-library');
const moment = require('moment');
const request = require('request-promise-native');
const fs = require('fs');
const path = require('path');

const tableName = 'pictures';
const mimeRegex = /^image\//;
const pageSize = 100;
const geoApi = 'https://nominatim.openstreetmap.org/reverse';
const geoInterval = 1100;
const throwbackFrequency = 15; // show a throwback about every X pictures
const mostRecent = 50;
const daysWeightWindow = 5; // the probability for pictures this many days or older
const msInDay = 1000 * 60 * 60 * 24;
var isGeocoding = false;

module.exports = class pictureManager {

  /**
   * Construct a new pictureManager object.
   * @param {sqlite3.Database} db
   * @param {keyValue} keyValue
   */
  constructor(db, keyValue) {
    this.keyValue = keyValue;

    // create a promise that resolves when the required table is ready to go
    const dbPromise = new Promise((resolve, reject) => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (
        id TEXT PRIMARY KEY,
        ext TEXT,
        author TEXT,
        added INTEGER,
        taken INTEGER,
        location TEXT
      )`, (err) => {
        err ? reject(err) : resolve(db);
      });
    });
    this.db = () => {
      return dbPromise;
    };

    // create a promise that resolves to the drive object
    const drivePromise = auth.getClient({
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/drive.appdata',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.metadata',
        'https://www.googleapis.com/auth/drive.metadata.readonly',
        'https://www.googleapis.com/auth/drive.photos.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    }).then((client) => {
      return google.drive({
        version: 'v3',
        auth: client,
      });
    });
    this.drive = () => {
      return drivePromise;
    }

    this.syncFiles = this.syncFiles.bind(this);
    this.geocodeLocations = this.geocodeLocations.bind(this);
  }

  /**
   * Sync files from Google Drive.
   */
  async syncFiles() {
    console.debug('syncing files');
    const drive = await this.drive();
    const pageToken = await this.keyValue.get('changesPageToken');

    // if we have no page token, grab all images
    if (!pageToken) {
      // save page token if there are multiple pages of results
      let nextPageToken;
      do {
        let params = {
          pageSize,
          fields: '*',
        };
        if (nextPageToken) {
          params.pageToken = nextPageToken;
        }
        let resp = await drive.files.list(params);

        if (resp && resp.data) {
          nextPageToken = resp.data.nextPageToken;
          for (let file of resp.data.files) {
            // skip trashed files!
            if (file.trashed) {
              continue;
            }
            this.addFile(file);
          }
        }
      } while (nextPageToken);

      let resp = await drive.changes.getStartPageToken();
      if (resp && resp.data && resp.data.startPageToken) {
        await this.keyValue.set('changesPageToken', resp.data.startPageToken);
      }
    } else {
      let nextPageToken;
      do {
        let resp = await drive.changes.list({
          pageToken,
          pageSize,
          fields: '*',
          includeRemoved: true,
        }).catch(console.error);

        // is there a response?
        if (resp && resp.data) {
          for (let change of resp.data.changes) {
            // skip anything that isn't a file change
            if (change.type !== 'file') {
              continue;
            }

            if (change.removed || (change.file && change.file.trashed)) {
              // handle a removal
              await this.removeFile(change.fileId);
            } else if (change.file) {
              // handle a new image
              await this.addFile(change.file);
            }
          }

          nextPageToken = resp.data.nextPageToken;
          // do we have a new page token for next time?
          if (resp.data.newStartPageToken && resp.data.newStartPageToken !== pageToken) {
            await this.keyValue.set('changesPageToken', resp.data.newStartPageToken);
          }
        }
      } while (nextPageToken);
    }
  }

  /**
   * Add a new file to the database.
   * @param {object} file
   */
  async addFile(file) {
    // check that we care about this kind of file
    if (!mimeRegex.test(file.mimeType)) {
      return;
    }

    console.debug('adding file');
    console.dir(file, {depth: null});

    const db = await this.db();

    // process metadata if we have it
    var coords, taken;
    if (file.imageMediaMetadata) {
      if (file.imageMediaMetadata.location) {
        coords = JSON.stringify({
          lat: file.imageMediaMetadata.location.latitude,
          lon: file.imageMediaMetadata.location.longitude,
        });
      }

      if (file.imageMediaMetadata.time) {
        // if it's a string, parse it
        if (file.imageMediaMetadata.time.replace) {
          // standardize by replacing weird date separator chars
          let time = file.imageMediaMetadata.time.replace(/(\d{4})\D(\d{2})\D(\d{2})/, '$1-$2-$3');
          taken = moment(time).unix();
        } else {
          // otherwise assume it's a unix timestamp
          taken = file.imageMediaMetadata.time;
        }
      }
    }

    return new Promise((resolve, reject) => {
      db.run(`INSERT OR IGNORE INTO ${tableName}(id, ext, author, added, taken, location)
        VALUES ($id, $ext, $author, $added, $taken, $location)
      `, {
        $id: file.id,
        $ext: file.fileExtension,
        $author: file.owners && file.owners[0] && file.owners[0].displayName,
        $added: moment(file.createdTime).unix(),
        $taken: taken,
        $location: coords,
      }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
          // kick off the geocoding, if it isn't already
          this.geocodeLocations();
        }
      });
    });
  }

  /**
   * Remove a file with the given ID from the database.
   * @param {*} id
   */
  async removeFile(id) {
    console.log(`removing file ${id}`);
    const db = await this.db();
    return new Promise((resolve, reject) => {
      db.run(`DELETE FROM ${tableName} WHERE id = ?`, id, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }

  /**
   * Kick off the geocoding process, handling one geocode on the interval defined above.
   */
  async geocodeLocations() {
    console.log('starting geocode');
    const db = await this.db();
    if (isGeocoding) {
      return false;
    }
    isGeocoding = true;
    db.get(`SELECT id, location FROM ${tableName} WHERE location LIKE '{%' LIMIT 1`, (err, row) => {
      if (err || !row) {
        isGeocoding = false;
        return;
      }

      let qs = JSON.parse(row.location);
      qs.format = 'json';
      qs.zoom = 10;

      request({
        url: geoApi,
        qs,
        json: true,
        headers: {
          'User-Agent': 'Frunch Room',
        },
      })
      .then((data) => {
        console.dir(data, {depth: null});
        let location = null;
        if (data && data.address) {
          location = `${data.address.city}, ${data.address.country_code === 'us' ? data.address.state : data.address.country}`;
        }

        db.run(`UPDATE ${tableName} SET location = ? WHERE id = ?`, location, row.id, (err) => {
          isGeocoding = false;
          setTimeout(this.geocodeLocations, geoInterval);
        });
      })
      .catch((err) => {
        console.error(err);
        isGeocoding = false;
      });
    });
  }

  /**
   * Select a random image per the weight rules.
   * @param {Array} notIds
   */
  async selectRandom(notIds = []) {
    const db = await this.db();
    // @todo: we should really properly escape the IDs, but they should be safe
    let notInClause = notIds.length ? `WHERE id NOT IN (${notIds.map((id) => `'${id}'`).join(', ')})` : '';
    // should we choose a random throwback?
    if (Math.random() < 1 / throwbackFrequency) {
      let resp = await (new Promise((resolve, reject) => {
        db.get(`SELECT * FROM (SELECT * FROM ${tableName} ORDER BY added DESC LIMIT -1 OFFSET ${mostRecent}) ${notInClause} ORDER BY RANDOM()`, (err, row) => {
          err ? reject(err) : resolve(row);
        });
      }));

      if (resp) {
        return resp;
      }
    }

    return new Promise((resolve, reject) => {
      db.all(`SELECT * FROM (SELECT * FROM ${tableName} ORDER BY added DESC LIMIT ${mostRecent}) ${notInClause}`, (err, rows) => {
        if (err) {
          return reject(err);
        }

        let weights = [];
        let total = 0;
        let now = Date.now();
        for (let row of rows) {
          // find out how many days ago - minimum 1 ms, max daysWeightWindow
          let dayDiff = Math.min((Math.max(1, now - row.added)) / msInDay, daysWeightWindow);
          let weight = daysWeightWindow / dayDiff;
          weights.push(total + weight);
          total += weight;
        }

        // pick a random number somewhere between 0 and our total
        let pick = Math.random() * total;
        // @todo: a bisect search would be technically faster but not noticeably so with this few elements
        for (let i in weights) {
          if (weights[i] >= pick) {
            return resolve(rows[i]);
          }
        }
      });
    });
  }

  /**
   * Get the filepath of the image, downloading if necessary.
   * @param {string} id
   */
  async getFilePath(id) {
    const drive = await this.drive();
    const db = await this.db();
    return new Promise((resolve, reject) => {
      db.get(`SELECT ext FROM ${tableName} WHERE id = ?`, id, async (err, row) => {
        if (err) {
          return reject(err);
        }

        const filePath = path.join(process.cwd(), 'public/images', `${id}.${row.ext}`);
        // check to see if the file exists
        const fileExists = await (new Promise((resolve, reject) => {
          fs.access(filePath, fs.F_OK, (error) => {
            resolve(!error);
          });
        }));
        if (fileExists) {
          return resolve(filePath);
        }

        const dest = fs.createWriteStream(filePath);
        const res = await drive.files.get(
          {fileId: id, alt: 'media'},
          {responseType: 'stream'}
        ).catch(reject);

        // @todo resize large images
        if (res.data) {
          res.data
            .on('end', () => {
              console.log('Done downloading file.');
              resolve(filePath);
            })
            .on('error', (err) => {
              console.error('Error downloading file.');
              reject(err);
            })
            .pipe(dest);
        }
      });

    });
  }
}
