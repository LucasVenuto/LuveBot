"""The avatar proofs' PNG builders (tests/harness/png_fixture.py), checked OFFLINE against the real validator (`backend/png_avatar.py`): what the AV-4 proof sends is what the server's contract says it is.

  python -m pytest -q tests/harness/test_png_fixture.py"""
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import png_fixture as fx  # noqa: E402


@pytest.fixture(scope='module')
def png_avatar():
    package = types.ModuleType('luvebot_backend_png_fixture')
    package.__path__ = [str(ROOT / 'backend')]
    sys.modules[package.__name__] = package
    from importlib import import_module
    return import_module(package.__name__ + '.png_avatar')


def test_the_canvas_like_image_is_valid_and_comes_back_as_the_canonical_png(png_avatar):
    out = png_avatar.reencode(fx.valid())
    assert fx.channels_of(out) == [b'IHDR', b'IDAT', b'IEND'] and fx.decoded(out) == fx.pixels() and png_avatar.reencode(out) == out      # the same pixels; re-encoding it gives itself back
    assert len(out) <= png_avatar.STORED_CAP and len(fx.valid()) <= png_avatar.READ_CAP
    assert png_avatar.reencode(fx.valid(ctype=2))                                                           # RGB too
    assert png_avatar.reencode(fx.valid(seed=1)) != png_avatar.reencode(fx.valid(seed=2))                    # another seed, another image (another id on the route)


def test_the_metadata_chunks_are_dropped_never_copied(png_avatar):
    out = png_avatar.reencode(fx.with_metadata())
    assert fx.SENTINEL not in out and out == png_avatar.reencode(fx.valid())                                 # the same image as the plain one: what the file carried changes nothing
    assert any(kind in fx.with_metadata() for kind in (b'eXIf', b'tEXt', b'iTXt', b'zTXt')) and fx.SENTINEL in fx.with_metadata()


@pytest.mark.parametrize('name', sorted(fx.poisoned()))
def test_each_poisoned_image_is_refused_for_the_reason_it_is_labeled_with(png_avatar, name):
    body, why = fx.poisoned()[name]
    with pytest.raises(png_avatar.InvalidImage) as refused:
        png_avatar.reencode(body)
    assert refused.value.why == why and fx.SENTINEL.decode() not in str(refused.value.message)
