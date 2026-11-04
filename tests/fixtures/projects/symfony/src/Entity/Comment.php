<?php

namespace App\Entity;

use App\Entity\Traits\TimestampableTrait;
use App\Model\PlainBase;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Comment extends PlainBase
{
    use TimestampableTrait;

    #[ORM\Id]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne(targetEntity: Post::class)]
    private ?Post $post = null;

    #[ORM\Embedded(class: Money::class)]
    private Money $tip;
}
