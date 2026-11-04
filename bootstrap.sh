#!/usr/bin/env bash
# Baixa o Multer e instala, sem git e sem login no GitHub. Rodar de novo atualiza.
# Tudo fica dentro de main: um download cortado no meio não executa nada pela metade.
set -euo pipefail

main() {
  local url="https://github.com/lexersonly/multer-android/archive/refs/heads/main.tar.gz"
  target="${MULTER_DIR:-$HOME/multer-android}"
  temp="$target.download"
  trap 'rm -rf "$temp"' EXIT

  if [ -z "${PREFIX:-}" ] || ! command -v pkg >/dev/null 2>&1; then
    echo "Este instalador é para o Termux." >&2
    exit 1
  fi
  command -v curl >/dev/null 2>&1 || pkg install -y curl

  rm -rf "$temp"
  mkdir -p "$temp"
  echo "Baixando o Multer..."
  curl -fsSL "$url" | tar xz --strip-components=1 -C "$temp"
  if [ ! -f "$temp/install.sh" ]; then
    echo "O download veio incompleto. Rode de novo." >&2
    exit 1
  fi

  # A pasta antiga só sai depois do download completo. O login fica em ~/.config.
  rm -rf "$target"
  mv "$temp" "$target"
  bash "$target/install.sh"
}

# Com `curl | bash`, a entrada é o próprio script: nada do pkg pode ler dela.
main "$@" </dev/null
