"""Explicit public-asset download only; inference requests are always offline."""
import argparse
from huggingface_hub import snapshot_download
from .embedding_models import QWEN_ID,QWEN_REVISION,HARRIER_ID,HARRIER_REVISION,cache_directory


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--model",choices=["qwen","harrier"],default="qwen")
    args=parser.parse_args()
    name,revision=(QWEN_ID,QWEN_REVISION) if args.model=="qwen" else (HARRIER_ID,HARRIER_REVISION)
    snapshot_download(name,revision=revision,cache_dir=cache_directory(),token=False,
        allow_patterns=["*.json","*.safetensors","*.txt","*.model"],max_workers=2)
    if args.model=="harrier":
        snapshot_download(QWEN_ID,revision=QWEN_REVISION,cache_dir=cache_directory(),token=False,
            allow_patterns=["*.json","*.txt","*.model"],max_workers=2)
    print("Cached pinned public assets: "+name)


if __name__=="__main__":
    main()
