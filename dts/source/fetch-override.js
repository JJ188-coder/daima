(function() {
  var __dts_origFetch = window.fetch.bind(window);
  var __dts_cdnDomains = ["assets.diantoushi.com","assets.zhenghedata.com","assets.aminggongju.com"];
  window.fetch = function(input, init) {
    var url = (typeof input === "string") ? input : (input && input.url ? input.url : null);
    if (url) {
      try {
        var parsed = new URL(url, window.location.href);
        if (__dts_cdnDomains.indexOf(parsed.hostname) >= 0) {
          var rid = window.DTS_ISOLATED && window.DTS_ISOLATED.dts_runtime_id;
          if (rid) return __dts_origFetch("chrome-extension://" + rid + "/remotes" + parsed.pathname).catch(function(){return __dts_origFetch(url);});
        }
      } catch(e) {}
    }
    return __dts_origFetch(input, init);
  };
})();
