const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const keyValue = require('./src/keyValue');
const pictureManager = require('./src/pictureManager');
const moment = require('moment');
const path = require('path');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const port = 3000;
const db = new sqlite3.Database('frunch-room.sqlite');
const options = new keyValue(db);
const pictures = new pictureManager(db, options);
const syncInterval = 60 * 1000;
const pictureInterval = 20 * 1000; // how often a new picture should be shown
const pictureTimeout = 60 * 1000; // max wait time to retrieve a new picture
const minRepeat = 10; // minimum number of pictures to show before repeating
const history = [];
var currentPicture;

app.use(express.static('public'));

http.listen(port, () => {
  console.log(`Listening on port ${port}!`);
});

/**
 * Get a random picture object.
 */
async function getPicture() {
  return pictures.selectRandom(history).then(async (picture) => {
    picture.path = path.join('/images', path.basename(await pictures.getFilePath(picture.id)));
    picture.when = `${!picture.taken ? 'added ' : ''} ${moment.unix(picture.taken || picture.added).fromNow()}`;
    // strip out non-processed GPS coords
    if (picture.location && picture.location[0] === '{') {
      picture.location = '';
      // make sure we are taking care of it
      pictures.geocodeLocations();
    }
    return picture;
  });
}

/**
 * Set and emit the current picture.
 */
function setPicture(picture) {
  if (!picture) {
    return;
  }
  currentPicture = picture;
  history.unshift(picture.id);
  // truncate the history array
  if (history.length > minRepeat) {
    history.length = minRepeat;
  }
  io.emit('new picture', picture);
}

/**
 * Start the scheduling of pictures.
 */
async function schedulePictures() {
  // get and set a picture right away
  setPicture(await getPicture());

  while (true) {
    // queue the next picture
    setPicture((await Promise.all([
      getPicture(),
      new Promise((resolve, reject) => {
        setTimeout(resolve, pictureInterval);
        // reject after a long timeout
        setTimeout(reject, pictureTimeout);
      }),
    ]).catch(console.error))[0]);
  }
}

async function main() {
  // immediately start syncing files
  await pictures.syncFiles();
  // set up an interval to sync files
  setInterval(pictures.syncFiles, syncInterval);
  // make sure there are no lingering records that need geocoding
  pictures.geocodeLocations();

  io.on('connection', (socket) => {
    // immediately send the current picture when a client connects
    socket.emit('new picture', currentPicture);
    console.log('client connected');
  });

  schedulePictures();
}

main().catch(console.error);
