function formatDateTime(date) {
  const pad = n => n.toString().padStart(2, '0');
  // const y = date.getFullYear();
  // const m = pad(date.getMonth() + 1);
  // const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // return `${y}-${m}-${d} ${h}:${mi}:${s}`;
  return `${h}:${mi}:${s}`;
}

function rLog(that, level, log) {
  const levelColorMap = {
    "info": "primary",
    "debug": "primary",
    "success": "success",
    "warn": "warn",
    "warning": "warn",
    "err": "danger",
    "error": "danger",
    "fail": "danger"
  };
  const now = new Date();
  const formatedDate = formatDateTime(now);
  let logList = that.data.logList || [];
  logList.push({
    time: formatedDate,
    level: level.toUpperCase(),
    color: levelColorMap[level] || "primary",
    log: log
  });
  setTimeout(() => {
    that.setData({ scrollAnchorId: "bottom-anchor" });
  }, 100);
  setTimeout(() => {
    that.setData({ scrollAnchorId: "" });
  }, 100);
  that.setData({
    logList: logList
  });
}

module.exports = rLog;