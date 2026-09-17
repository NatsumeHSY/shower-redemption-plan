function formatTime(date) {
  const pad = n => n.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function rLog(that, level, log) {
  // 日志级别 → 页面配色
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
  const time = formatTime(new Date());
  let logList = that.data.logList || [];
  logList.push({
    time,
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