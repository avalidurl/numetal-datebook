# ClusterFuzzLite — coverage-guided (Jazzer.js) fuzzing of the money/safety decoders.
FROM gcr.io/oss-fuzz-base/base-builder-javascript
COPY . $SRC/numetal-datebook
WORKDIR $SRC/numetal-datebook
COPY .clusterfuzzlite/build.sh $SRC/build.sh
