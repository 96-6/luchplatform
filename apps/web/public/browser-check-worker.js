// Independent realm; no external requests, device inventory or persistent fingerprinting.
self.onmessage = async function () {
  var n = self.navigator;
  var hints = null;
  if (n.userAgentData) {
    var data = n.userAgentData;
    var brands = data.brands;
    try {
      if (data.getHighEntropyValues) {
        var full = await Promise.race([
          data.getHighEntropyValues(['fullVersionList']),
          new Promise(function (resolve) {
            setTimeout(function () {
              resolve({});
            }, 1000);
          }),
        ]);
        brands = full.fullVersionList || brands;
      }
    } catch (_) {}
    hints = {
      brands: Array.from(brands).slice(0, 12),
      platform: data.platform || '',
      mobile: !!data.mobile,
    };
  }
  self.postMessage({
    userAgent: n.userAgent.slice(0, 1024),
    platform: (n.platform || '').slice(0, 80),
    hints: hints,
  });
};
