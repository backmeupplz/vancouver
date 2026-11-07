# GDAL that reads the City of Vancouver's ECW orthophotos: Debian's GDAL plus its ECW driver built as a plugin
# against the open-source libecwj2 3.3 SDK (reads ECW v2). Used by tools/ortho.sh; nothing else needs ECW.
FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends build-essential unzip ca-certificates curl cmake \
    gdal-bin libgdal-dev libproj-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -sSLo e.zip https://github.com/bogind/libecwj2-3.3/raw/master/libecwj2-3.3-2006-09-06.zip \
 && echo '038fddae2107617f37d0a8003633059b94eaaea76b414775b4836e1b89c47295  e.zip' | sha256sum -c && unzip -q e.zip && rm e.zip \
 && cd libecwj2-3.3 && ./configure --build=$(uname -m)-unknown-linux-gnu --prefix=/usr/local \
 && make -j4 CXXFLAGS="-O2 -fpermissive -w -std=gnu++98 -fsigned-char" CFLAGS="-O2 -w -fsigned-char" && make install && ldconfig \
 && cd .. && rm -rf libecwj2-3.3
# the ECW driver of the same GDAL version Debian ships, built as a plugin only
RUN v=$(gdal-config --version) && curl -sSL https://download.osgeo.org/gdal/$v/gdal-$v.tar.gz | tar xz \
 && cd gdal-$v && mkdir b && cd b && cmake .. -DCMAKE_BUILD_TYPE=Release -DGDAL_BUILD_OPTIONAL_DRIVERS=OFF -DOGR_BUILD_OPTIONAL_DRIVERS=OFF \
    -DBUILD_APPS=OFF -DBUILD_PYTHON_BINDINGS=OFF -DBUILD_TESTING=OFF -DGDAL_USE_ECW=ON -DECW_ROOT=/usr/local \
    -DGDAL_ENABLE_DRIVER_ECW=ON -DGDAL_ENABLE_DRIVER_ECW_PLUGIN=ON > /tmp/cmake.log \
 && grep -i ecw /tmp/cmake.log; make -j4 gdal_ECW_JP2ECW \
 && cp $(find . -name 'gdal_ECW_JP2ECW.so') $(dirname $(find /usr/lib -name 'libgdal.so.*' | head -1))/gdalplugins/ \
 && cd /src && rm -rf gdal-$v && gdalinfo --formats | grep -i ecw
