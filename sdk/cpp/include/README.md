# sdk/cpp/include/ - SDK Include Root

The directory to put on the compiler's include path (`-I sdk/cpp/include`;
`sdk/cpp/build.sh` adds it). Everything lives under `abject/`, so sources
write `#include <abject/abject.hpp>`.

## Files

- **abject/**: the SDK header and its vendored JSON library. See
  [abject/README.md](abject/README.md).

## Related

- [../README.md](../README.md): the C++ SDK, its programming model and build
