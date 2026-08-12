# Token-bucket sample

This small JavaScript rate limiter is the deterministic fixture for the OpenWiki
reasoning-effort reproduction script. It preserves partial refill time instead
of resetting the refill clock to the latest request.

Run its tests with:

```sh
npm test
```
