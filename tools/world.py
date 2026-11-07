# The map's frame: world metres east (x) and north (y) of an origin in downtown Vancouver, equirectangular.
# Heights are real elevations in metres (CGVD2013, from NRCan HRDEM / MRDEM).
import math

LAT_O, LON_O, SC = 49.28606407, -123.10901045, 0.99744659
KX = 111320 * math.cos(math.radians(49.2845)) / SC  # metres per degree of longitude
KY = 110574 / SC                                     # metres per degree of latitude
BBOX = (48.99, -123.33, 49.48, -122.40)              # S, W, N, E: the Lower Mainland and the North Shore mountains
L0, L1, L2 = 1024, 4096, 16384                       # tile sizes per level of detail, metres


def xy(lat, lon):
    return ((lon - LON_O) * KX, (lat - LAT_O) * KY)


def latlon(x, y):
    return (LAT_O + y / KY, LON_O + x / KX)


def extent():
    x0, y0 = xy(BBOX[0], BBOX[1]); x1, y1 = xy(BBOX[2], BBOX[3])
    return x0, y0, x1, y1
