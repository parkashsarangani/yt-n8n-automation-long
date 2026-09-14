// FFmpeg concat demuxer file directive, including Windows separators.
function concatPath(file) { return file.replace(/\\/g, '/').replace(/'/g, "'\\''"); }
module.exports = {concatPath};
