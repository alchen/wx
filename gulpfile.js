'use strict';

var gulp = require('gulp');
var sass = require('gulp-sass');

gulp.task('default', function() {
  // place code for your default task here
});

gulp.task('sass', function () {
  gulp.src('./src/static/css/**/*.scss')
      .pipe(sass().on('error', sass.logError))
      .pipe(gulp.dest('./src/static/css/'));
});

gulp.task('sass:w', function () {
  gulp.watch('./src/static/css/**/*.scss', ['sass']);
});
