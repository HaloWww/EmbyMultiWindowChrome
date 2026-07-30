(function () {
    'use strict';
    window.define = function (dependencies, factory) {
        var exports = {};
        factory(exports);
        window.Hls = exports.default || exports.Hls || exports;
    };
    window.define.amd = {};
})();
