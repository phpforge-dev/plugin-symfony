<?php

namespace App\Entity;

use Doctrine\ORM\Mapping as ORM;

#[ORM\Embeddable]
class Money
{
    #[ORM\Column]
    private int $amount = 0;

    #[ORM\Column(length: 3)]
    private string $currency = 'BRL';
}
