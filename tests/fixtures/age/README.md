# age fixtures

Produced with the reference `age` 1.1.1 command-line tools, to check that Crypte reads files it did not write. The identity is a test key; do not use it for anything else.

```sh
age-keygen -o identity.txt
age -p -o passphrase.age hello.txt                       # passphrase: crypte-demo, scrypt work factor 18
age -r "$(age-keygen -y identity.txt)" -o hello.age hello.txt
age -r "$(age-keygen -y identity.txt)" -o empty.age empty.bin
age -r "$(age-keygen -y identity.txt)" -o chunk-boundary.age boundary.bin
age -a -r "$(age-keygen -y identity.txt)" -o multi-chunk.armored.age multi.bin
```

`hello.txt` contains `Hello from age.` and a newline. `empty.bin` is empty. `boundary.bin` (65,536 bytes, exactly one payload chunk) and `multi.bin` (70,000 bytes) contain byte `i` = `(31 × i + 7) mod 251`.
