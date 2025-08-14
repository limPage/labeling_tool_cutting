const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  if (app.isPackaged) {
    // 배포 모드 - 빌드된 index.html 불러오기
    win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  } else {
    // 개발 모드 - Vite dev 서버 접속
    win.loadURL('http://localhost:5173')
  }
}

app.whenReady().then(createWindow)
